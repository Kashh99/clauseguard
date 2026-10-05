import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import Anthropic, { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import pdfParse from 'pdf-parse';
import { kv } from '@vercel/kv';
import { JURISDICTIONS } from '@/lib/types';
import type { ContractAnalysis, Jurisdiction } from '@/lib/types';
import { SAMPLE_CONTRACTS } from '@/lib/samples';

// Timeout budget: up to 2 attempts × 120s = 240s for the Claude call, leaving headroom for
// PDF parsing under the 300s function limit. A full analysis takes ~50s, so the old 60s
// limit let Vercel kill the function before our own 504 handler could run.
export const maxDuration = 300;

const DAILY_LIMIT = 20;

const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });

const MAX_TEXT_CHARS = 60_000;

const SAMPLE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Static instructions — cached at the API layer to avoid re-tokenizing on every request.
const SYSTEM_PROMPT = `You are a legal assistant specializing in contract analysis. Your role is to help non-lawyers understand contracts in plain English.

When given a contract, you will:
1. Identify all significant clauses (aim for 8–15 clauses covering the most important terms)
2. Assess each clause's risk level for the party signing the contract:
   - green: Standard and fair — common in contracts of this type, no cause for concern
   - amber: Worth watching — unusual, one-sided, or potentially unfavorable; ask for clarification
   - red: Risky or highly unusual — strongly consider negotiating or seeking independent legal advice
3. Explain each clause in clear, jargon-free language a non-lawyer can act on
4. Provide a negotiation tip for amber and red clauses (null for green)

You must return a single valid JSON object matching this exact schema — no markdown, no code fences, no prose outside the JSON:

{
  "summary": "2–3 sentence plain-English overview of what this contract is and any major concerns",
  "contractType": "Lease Agreement | Employment Contract | Service Agreement | Other",
  "clauses": [
    {
      "title": "Short clause name (e.g. 'Rent Increase', 'Non-Compete', 'Termination Without Cause')",
      "excerpt": "Verbatim quote of the most relevant sentence(s) from the contract, max 250 chars",
      "riskLevel": "green | amber | red",
      "explanation": "Plain-English explanation of what this clause means for the signer",
      "negotiationTip": "Specific, actionable negotiation tip, or null if the clause is green"
    }
  ]
}`;

type AnalysisResult =
  | { ok: true; analysis: ContractAnalysis }
  | { ok: false; status: number; error: string };

async function analyzeContract(
  contractText: string,
  jurisdiction: Jurisdiction,
  contractTypeHint: string | null,
): Promise<AnalysisResult> {
  const truncated =
    contractText.length > MAX_TEXT_CHARS
      ? contractText.slice(0, MAX_TEXT_CHARS) + '\n\n[Document truncated for analysis]'
      : contractText;

  // Send to Claude. The system prompt is marked for prompt caching; the contract
  // text is never cached since every document is unique.
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Analyze this contract for someone in ${jurisdiction}.${contractTypeHint ? ` The user has identified this as a ${contractTypeHint}.` : ''} Apply ${jurisdiction} law, tenant/employee protections, and local market standards when assessing risk.

CONTRACT:
${truncated}`,
        },
      ],
    });
  } catch (err) {
    if (err instanceof APIConnectionTimeoutError) {
      return { ok: false, status: 504, error: 'Analysis timed out — please try again' };
    }
    throw err;
  }

  const responseBlock = message.content[0];
  if (responseBlock.type !== 'text') {
    return { ok: false, status: 500, error: 'Unexpected response format from AI' };
  }

  // Strip markdown code fences if Claude wraps the JSON anyway.
  const raw = responseBlock.text.trim();
  const jsonText = raw.startsWith('```')
    ? raw.slice(raw.indexOf('\n') + 1, raw.lastIndexOf('```')).trim()
    : raw;

  let analysis: ContractAnalysis;
  try {
    analysis = JSON.parse(jsonText);
  } catch {
    return { ok: false, status: 500, error: 'AI returned malformed JSON — please retry' };
  }

  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.clauses)) {
    return { ok: false, status: 500, error: 'AI returned an unexpected response shape — please retry' };
  }

  const VALID_RISK = new Set(['green', 'amber', 'red']);
  const invalidClause = analysis.clauses.find(
    c => !c.title || !VALID_RISK.has(c.riskLevel),
  );
  if (invalidClause) {
    return { ok: false, status: 500, error: 'AI returned invalid clause data — please retry' };
  }

  analysis.jurisdiction = jurisdiction;
  return { ok: true, analysis };
}

// Sample analyses are deterministic inputs, so each (sample, jurisdiction) pair is analyzed
// once and served from cache afterwards. The key includes a hash of the model, prompt and
// sample text so editing any of them invalidates stale results. The in-memory map also
// dedupes concurrent misses within an instance and covers local dev without KV.
const sampleMemo = new Map<string, Promise<AnalysisResult>>();

function analyzeSample(sampleId: string, jurisdiction: Jurisdiction): Promise<AnalysisResult> {
  const sample = SAMPLE_CONTRACTS[sampleId];
  const version = createHash('sha256')
    .update(`${MODEL}\0${SYSTEM_PROMPT}\0${sample.text}`)
    .digest('hex')
    .slice(0, 12);
  const key = `sample:${sampleId}:${jurisdiction}:${version}`;

  const pending = sampleMemo.get(key);
  if (pending) return pending;

  const result = (async (): Promise<AnalysisResult> => {
    try {
      const cached = await kv.get<ContractAnalysis>(key);
      if (cached) return { ok: true, analysis: cached };
    } catch {
      // KV unavailable — fall through to a live analysis.
    }

    const fresh = await analyzeContract(sample.text, jurisdiction, sample.contractType);
    if (fresh.ok) {
      try {
        await kv.set(key, fresh.analysis, { ex: SAMPLE_CACHE_TTL_SECONDS });
      } catch {
        // KV unavailable — the in-memory memo still serves this instance.
      }
    }
    return fresh;
  })();

  sampleMemo.set(key, result);
  // Only successes stay memoized; a failure (timeout, bad JSON) can be retried.
  result.then(r => { if (!r.ok) sampleMemo.delete(key); }, () => sampleMemo.delete(key));
  return result;
}

function toResponse(result: AnalysisResult) {
  return result.ok
    ? Response.json(result.analysis)
    : Response.json({ error: result.error }, { status: result.status });
}

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  // Free-text input used to skip the rate limit, which let anyone run unlimited analyses.
  if (formData.has('text')) {
    return Response.json(
      { error: 'Text input is no longer supported. Please refresh the page and upload a PDF or use the sample.' },
      { status: 400 },
    );
  }

  const file = formData.get('file') as File | null;
  const jurisdiction = formData.get('jurisdiction') as string | null;
  const contractTypeHint = formData.get('contractType') as string | null;
  const sampleId = formData.get('sample');

  if (!jurisdiction || !(JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    return Response.json(
      { error: `"jurisdiction" must be one of: ${JURISDICTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  // Samples are served from cache, so they don't count against the daily limit.
  if (sampleId !== null) {
    if (typeof sampleId !== 'string' || !Object.hasOwn(SAMPLE_CONTRACTS, sampleId)) {
      return Response.json({ error: 'Unknown sample' }, { status: 400 });
    }
    return toResponse(await analyzeSample(sampleId, jurisdiction as Jurisdiction));
  }

  // Rate-limit PDF uploads.
  try {
    const dateKey = `analyses:${new Date().toISOString().slice(0, 10)}`;
    const count = (await kv.get<number>(dateKey)) ?? 0;
    if (count >= DAILY_LIMIT) {
      return Response.json(
        { error: 'Daily demo limit reached. Come back tomorrow, or clone the repo and use your own API key from console.anthropic.com — it only takes 2 minutes.' },
        { status: 429 },
      );
    }
    await kv.set(dateKey, count + 1, { ex: 86400 });
  } catch {
    // KV unavailable (local dev without env vars) — skip rate limiting.
  }

  if (!file || file.type !== 'application/pdf') {
    return Response.json({ error: 'A PDF file is required (field name: "file")' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await pdfParse(buffer);
  const contractText = parsed.text.trim();

  if (!contractText) {
    return Response.json(
      { error: 'Could not extract any text from this PDF. It may be scanned or image-only.' },
      { status: 422 },
    );
  }

  return toResponse(await analyzeContract(contractText, jurisdiction as Jurisdiction, contractTypeHint));
}
