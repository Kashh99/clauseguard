import type { NextRequest } from 'next/server';
import Anthropic, { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { JURISDICTIONS } from '@/lib/types';
import type { ContractAnalysis, Jurisdiction } from '@/lib/types';

export const maxDuration = 60;

// pdfjs-dist v5 calls `new DOMMatrix()` at module-level (SCALE_MATRIX constant).
// DOMMatrix is not a Node.js global — pdfjs tries to borrow it from @napi-rs/canvas,
// which isn't installed on Vercel. We stub it here before pdfjs ever loads.
// The stub only needs to survive construction; actual transforms use .a/.b/.c/.d/.e/.f.
if (typeof (globalThis as Record<string, unknown>).DOMMatrix === 'undefined') {
  (globalThis as Record<string, unknown>).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length >= 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as [number, number, number, number, number, number];
      }
    }
  };
}

// Lazy-load pdfjs-dist so the DOMMatrix stub above is in place before the module
// evaluates its top-level code. Cached after first call (Node module cache).
type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let _pdfjs: PdfjsLib | null = null;
async function getPdfjs(): Promise<PdfjsLib> {
  if (_pdfjs) return _pdfjs;
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib;
  const { createRequire } = await import('module');
  const req = createRequire(import.meta.url);
  lib.GlobalWorkerOptions.workerSrc = `file://${req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')}`;
  _pdfjs = lib;
  return lib;
}

const client = new Anthropic();

const MAX_TEXT_CHARS = 60_000;

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

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  const jurisdiction = formData.get('jurisdiction') as string | null;
  const contractTypeHint = formData.get('contractType') as string | null;
  const directText = formData.get('text') as string | null;

  if (!directText && (!file || file.type !== 'application/pdf')) {
    return Response.json({ error: 'A PDF file is required (field name: "file")' }, { status: 400 });
  }
  if (!jurisdiction || !(JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    return Response.json(
      { error: `"jurisdiction" must be one of: ${JURISDICTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  let contractText = '';
  if (directText) {
    contractText = directText.trim();
  } else {
    const pdfjsLib = await getPdfjs();
    const uint8Array = new Uint8Array(await file!.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({
      data: uint8Array,
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;
    const pages = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) =>
        pdf.getPage(i + 1).then(p => p.getTextContent())
      )
    );
    contractText = pages
      .flatMap(p => p.items.map(item => ('str' in item ? (item as { str: string }).str : '')))
      .join(' ')
      .trim();
  }

  if (!contractText) {
    return Response.json(
      { error: 'Could not extract any text from this PDF. It may be scanned or image-only.' },
      { status: 422 },
    );
  }

  const truncated =
    contractText.length > MAX_TEXT_CHARS
      ? contractText.slice(0, MAX_TEXT_CHARS) + '\n\n[Document truncated for analysis]'
      : contractText;

  // Send to Claude. The system prompt is marked for prompt caching; the contract
  // text is never cached since every document is unique.
  let message: Anthropic.Message;
  try {
    message = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
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
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    if (err instanceof APIConnectionTimeoutError) {
      return Response.json({ error: 'Analysis timed out — please try again' }, { status: 504 });
    }
    throw err;
  }

  const responseBlock = message.content[0];
  if (responseBlock.type !== 'text') {
    return Response.json({ error: 'Unexpected response format from AI' }, { status: 500 });
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
    return Response.json({ error: 'AI returned malformed JSON — please retry' }, { status: 500 });
  }

  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.clauses)) {
    return Response.json({ error: 'AI returned an unexpected response shape — please retry' }, { status: 500 });
  }

  const VALID_RISK = new Set(['green', 'amber', 'red']);
  const invalidClause = analysis.clauses.find(
    c => !c.title || !VALID_RISK.has(c.riskLevel),
  );
  if (invalidClause) {
    return Response.json({ error: 'AI returned invalid clause data — please retry' }, { status: 500 });
  }

  analysis.jurisdiction = jurisdiction as Jurisdiction;

  return Response.json(analysis);
}
