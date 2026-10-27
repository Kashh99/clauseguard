import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import Anthropic, { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import pdfParse from 'pdf-parse';
import { kv } from '@vercel/kv';
import { JURISDICTIONS } from '@/lib/types';
import type { ContractAnalysis, Jurisdiction } from '@/lib/types';
import { SAMPLE_CONTRACTS } from '@/lib/samples';
import { clientKey, consumeQuota, refundClientQuota } from '@/lib/rate-limit';
import type { QuotaDenial, QuotaGrant } from '@/lib/rate-limit';
import { isTestMode, mockResponse, TEST_MODE_MARKER } from '@/lib/test-mode';

// Timeout budget: up to 2 attempts × 120s = 240s for the Claude call, leaving headroom for
// PDF parsing under the 300s function limit. A full analysis takes ~50s, so the old 60s
// limit let Vercel kill the function before our own 504 handler could run.
export const maxDuration = 300;


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

// `code` lets the client tell failure kinds apart. `upstream` marks failures the uploader
// can't cause (timeouts, API outages), which are the only ones that give back their quota slot.
// `quotaRefused` marks a denial that belongs to the visitor who was charged, not the request.
type AnalysisResult =
  | { ok: true; analysis: ContractAnalysis }
  | { ok: false; status: number; error: string; code: string; upstream?: boolean; quotaRefused?: boolean };

function quotaRefusal(denial: QuotaDenial): AnalysisResult {
  return { ok: false, status: denial.status, error: denial.error, code: denial.code, quotaRefused: true };
}

// Logs never include contract text: only error names, messages and request metadata.
function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

// Every model call needs a quota grant, so no path can reach Claude without passing the daily caps.
async function analyzeContract(
  contractText: string,
  jurisdiction: Jurisdiction,
  contractTypeHint: string | null,
  quota: QuotaGrant,
): Promise<AnalysisResult> {
  const truncated =
    contractText.length > MAX_TEXT_CHARS
      ? contractText.slice(0, MAX_TEXT_CHARS) + '\n\n[Document truncated for analysis]'
      : contractText;

  // Backstop: the handler answers test-mode requests with a mock before reaching here.
  if (isTestMode()) throw new Error(`${TEST_MODE_MARKER}: real model call blocked`);
  if (quota?.ok !== true) throw new Error('model call attempted without a quota grant');

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
      console.error('analyze: Claude request timed out');
      return { ok: false, status: 504, error: 'Analysis timed out — please try again', code: 'analysis_timeout', upstream: true };
    }
    if (err instanceof APIError) {
      console.error('analyze: Claude API error', { name: err.name, status: err.status, requestId: err.requestID });
      return {
        ok: false,
        status: 502,
        error: 'The analysis service is having trouble right now — please try again in a moment.',
        code: 'analysis_unavailable',
        upstream: true,
      };
    }
    throw err;
  }

  const responseBlock = message.content[0];
  if (responseBlock?.type !== 'text') {
    console.error('analyze: unexpected response block', { type: responseBlock?.type, stopReason: message.stop_reason });
    return { ok: false, status: 500, error: 'Unexpected response format from AI', code: 'analysis_invalid' };
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
    console.error('analyze: malformed JSON from Claude', { stopReason: message.stop_reason, outputChars: raw.length });
    return { ok: false, status: 500, error: 'AI returned malformed JSON — please retry', code: 'analysis_invalid' };
  }

  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.clauses)) {
    console.error('analyze: unexpected JSON shape from Claude', { stopReason: message.stop_reason });
    return { ok: false, status: 500, error: 'AI returned an unexpected response shape — please retry', code: 'analysis_invalid' };
  }

  const VALID_RISK = new Set(['green', 'amber', 'red']);
  const invalidClause = analysis.clauses.find(
    c => !c.title || !VALID_RISK.has(c.riskLevel),
  );
  if (invalidClause) {
    console.error('analyze: invalid clause data from Claude', { clauses: analysis.clauses.length });
    return { ok: false, status: 500, error: 'AI returned invalid clause data — please retry', code: 'analysis_invalid' };
  }

  analysis.jurisdiction = jurisdiction;
  return { ok: true, analysis };
}

// Sample analyses are deterministic inputs, so each (sample, jurisdiction) pair is analyzed
// once and served from cache afterwards. The key includes a hash of the model, prompt and
// sample text so editing any of them invalidates stale results. The in-memory map also
// dedupes concurrent misses within an instance and covers local dev without KV.
const sampleMemo = new Map<string, Promise<AnalysisResult>>();

// Gives the visitor's slot back when Claude itself failed (timeout, outage).
async function analyzeWithRefund(
  contractText: string,
  jurisdiction: Jurisdiction,
  contractTypeHint: string | null,
  quota: QuotaGrant,
): Promise<AnalysisResult> {
  const result = await analyzeContract(contractText, jurisdiction, contractTypeHint, quota);
  if (!result.ok && result.upstream && quota.refundKey) await refundClientQuota(quota.refundKey);
  return result;
}

async function analyzeSample(sampleId: string, jurisdiction: Jurisdiction, clientId: string): Promise<AnalysisResult> {
  const sample = SAMPLE_CONTRACTS[sampleId];
  const version = createHash('sha256')
    .update(`${MODEL}\0${SYSTEM_PROMPT}\0${sample.text}`)
    .digest('hex')
    .slice(0, 12);
  const key = `sample:${sampleId}:${jurisdiction}:${version}`;

  // Concurrent requests for the same sample share one lookup and at most one model call, charged
  // to the request that started it. If that visitor was refused, the others retry on their own quota.
  let refused: Promise<AnalysisResult> | undefined;
  for (;;) {
    const pending = sampleMemo.get(key);
    if (pending && pending !== refused) {
      const shared = await pending;
      if (!shared.ok && shared.quotaRefused) {
        refused = pending;
        continue;
      }
      return shared;
    }

    const result = loadSample(key, sampleId, jurisdiction, clientId);
    sampleMemo.set(key, result);
    // Only successes stay memoized; a failure (refusal, timeout, bad JSON) can be retried.
    const forget = () => { if (sampleMemo.get(key) === result) sampleMemo.delete(key); };
    result.then(r => { if (!r.ok) forget(); }, forget);
    return result;
  }
}

// Cache hits are free. A miss is a real model call, so it passes the same daily caps as an upload,
// and a cache that can't be read counts as a miss rather than a reason to skip them.
async function loadSample(key: string, sampleId: string, jurisdiction: Jurisdiction, clientId: string): Promise<AnalysisResult> {
  const sample = SAMPLE_CONTRACTS[sampleId];
  try {
    const cached = await kv.get<ContractAnalysis>(key);
    if (cached) return { ok: true, analysis: cached };
  } catch {
    // KV unavailable — treat as a miss; the quota check below decides whether to call Claude.
  }

  const quota = await consumeQuota(clientId);
  if (!quota.ok) return quotaRefusal(quota);

  const fresh = await analyzeWithRefund(sample.text, jurisdiction, sample.contractType, quota);
  if (fresh.ok) {
    try {
      await kv.set(key, fresh.analysis, { ex: SAMPLE_CACHE_TTL_SECONDS });
    } catch {
      // KV unavailable — the in-memory memo still serves this instance.
    }
  }
  return fresh;
}

function toResponse(result: AnalysisResult) {
  return result.ok
    ? Response.json(result.analysis)
    : Response.json({ error: result.error, code: result.code }, { status: result.status });
}

// Anything that escapes the handler would otherwise reach the client as an empty-bodied 500.
export async function POST(request: NextRequest) {
  try {
    return await handleAnalyze(request);
  } catch (err) {
    console.error('analyze: unhandled error', {
      name: err instanceof Error ? err.name : typeof err,
      message: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return Response.json(
      { error: 'Something went wrong on our end — please try again.', code: 'server_error' },
      { status: 500 },
    );
  }
}

async function handleAnalyze(request: NextRequest): Promise<Response> {
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

  // Samples served from cache are free; a cache miss is charged like an upload.
  if (sampleId !== null) {
    if (typeof sampleId !== 'string' || !Object.hasOwn(SAMPLE_CONTRACTS, sampleId)) {
      return Response.json({ error: 'Unknown sample' }, { status: 400 });
    }
    // Skips the KV cache too, so a mock is never stored as a sample's real analysis.
    if (isTestMode()) return mockResponse(jurisdiction as Jurisdiction, 'sample');
    return toResponse(await analyzeSample(sampleId, jurisdiction as Jurisdiction, clientKey(request.headers)));
  }

  if (!file || file.type !== 'application/pdf') {
    return Response.json({ error: 'A PDF file is required (field name: "file")' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let contractText: string;
  try {
    // Pass a plain Uint8Array, not the Buffer: pdf.js's in-process worker copies a Buffer into
    // Node's shared allocation pool and then reads the whole pool, so parses of a valid PDF
    // intermittently fail ("bad XRef entry", "Command token too long") depending on pool contents.
    contractText = (await pdfParse(new Uint8Array(buffer) as Buffer)).text.trim();
  } catch (err) {
    // pdf-parse throws on damaged or non-standard PDFs (e.g. "bad XRef entry"). The byte counts,
    // hash and markers identify the upload and show truncation without logging its contents.
    console.error('analyze: PDF parse failed', {
      error: errorMessage(err),
      bytes: buffer.length,
      declaredBytes: file.size,
      sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
      pdfHeader: buffer.subarray(0, 5).toString('latin1') === '%PDF-',
      eofMarker: buffer.subarray(-1024).includes('%%EOF'),
    });
    return Response.json(
      {
        error: "We couldn't read this PDF — it may be damaged or use an unusual format. Try re-saving it (e.g. Print → Save as PDF) and uploading again.",
        code: 'pdf_unreadable',
      },
      { status: 422 },
    );
  }

  if (!contractText) {
    return Response.json(
      { error: 'Could not extract any text from this PDF. It may be scanned or image-only.', code: 'pdf_no_text' },
      { status: 422 },
    );
  }

  // Validation above still runs in test mode; only the model call (and its quota) is replaced.
  if (isTestMode()) return mockResponse(jurisdiction as Jurisdiction, 'upload');

  // Counted only once the request is about to reach Claude, so invalid uploads can't burn quota.
  const quota = await consumeQuota(clientKey(request.headers));
  if (!quota.ok) return toResponse(quotaRefusal(quota));

  return toResponse(await analyzeWithRefund(contractText, jurisdiction as Jurisdiction, contractTypeHint, quota));
}
