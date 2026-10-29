// Run with: npm test
// Proves the New York late-fee rule (Real Property Law § 238-a) reaches the model for New York
// uploads and samples, and that no other jurisdiction receives it. The model client is a stub:
// these tests check what the model is sent, not whether a real model rates the clause correctly.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.CLAUSEGUARD_TEST_MODE;
for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
  delete process.env[name];
}

// A fresh module instance per test, so one test's sample result can't be served to another.
const ROUTE_URL = new URL('../app/api/analyze/route.ts', import.meta.url).href;
let instance = 0;
const loadRoute = async () => (await import(`${ROUTE_URL}?instance=${++instance}`)).POST;

// Builds a one-page PDF with correct xref offsets. Each line becomes its own text line.
function buildPdf(lines) {
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map(l => `(${l}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const o = pdf.length; pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; return o; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// The late-fee terms of test lease B: $75 on $2,600 rent, charged after five days.
const NY_LEASE = [
  'RESIDENTIAL RENTAL AGREEMENT',
  'Monthly rent is $2,600, due on the first day of each month.',
  'If any rent payment is not received within five days of its due date,',
  'the Tenant will pay a late charge of $75.',
];

function upload(jurisdiction, lines = NY_LEASE) {
  const form = new FormData();
  form.append('file', new File([buildPdf(lines)], 'lease.pdf', { type: 'application/pdf' }));
  form.append('jurisdiction', jurisdiction);
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form });
}

function sample(jurisdiction) {
  const form = new FormData();
  form.append('sample', 'ontario-lease');
  form.append('jurisdiction', jurisdiction);
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form });
}

// What the stubbed model answers. It is fixed test data, not a model judgement.
const STUB_REPLY = {
  summary: 'stubbed analysis',
  contractType: 'Lease Agreement',
  clauses: [{
    title: 'Late Fee',
    excerpt: 'the Tenant will pay a late charge of $75.',
    riskLevel: 'red',
    explanation: 'stub: above the $50 cap in Real Property Law § 238-a(2)',
    negotiationTip: 'stub',
  }],
};

const RULE_MARKERS = ['§ 238-a', 'nysenate.gov/legislation/laws/RPP/238-A', 'JURISDICTION RULES'];

let modelCalls;
let networkCalls;
let POST;

beforeEach(async () => {
  POST = await loadRoute();
  modelCalls = mock.method(Anthropic.Messages.prototype, 'create', async () => (
    { content: [{ type: 'text', text: JSON.stringify(STUB_REPLY) }], stop_reason: 'end_turn' }
  ));
  networkCalls = mock.method(globalThis, 'fetch', async url => {
    throw new Error(`unexpected network call to ${url}`);
  });
});

afterEach(() => {
  mock.restoreAll();
});

// The text of the single model request: system prompt and user message.
function sentToModel() {
  assert.equal(modelCalls.mock.callCount(), 1);
  const [params] = modelCalls.mock.calls[0].arguments;
  return { system: params.system.map(b => b.text).join('\n'), user: params.messages[0].content };
}

test('a New York upload sends the § 238-a late-fee rule with its scope and exceptions', async () => {
  const res = await POST(upload('New York'));
  assert.equal(res.status, 200);
  const { user } = sentToModel();

  for (const marker of RULE_MARKERS) assert.ok(user.includes(marker), `missing ${marker}`);
  // The rule itself: more than five days late, and the lesser of $50 or 5% of monthly rent.
  assert.match(user, /within five days of its due date/);
  assert.match(user, /\$50 or 5% of the monthly rent, whichever is less/);
  assert.match(user, /§ 238-a\(3\).*void/);
  // Scope and exceptions, so the apartment rule isn't applied to other tenancies.
  assert.match(user, /residential dwelling unit/);
  assert.match(user, /cooperative housing corporation.*8% of the monthly maintenance fee/);
  assert.match(user, /§ 233\(r\)/);
  assert.match(user, /Commercial leases.*do(es)? not apply/);
  // The worked example for this lease and the instruction not to call an excessive fee standard.
  assert.match(user, /\$2,600 rent: 5% is \$130, so the cap is \$50/);
  assert.match(user, /rate it red/);
  assert.match(user, /Never rate it green or describe it as standard/);

  // The rules come before the contract, and the lease's own terms still reach the model.
  const contract = user.slice(user.indexOf('CONTRACT:'));
  assert.ok(user.indexOf('JURISDICTION RULES') < user.indexOf('CONTRACT:'));
  assert.match(contract, /Monthly rent is \$2,600/);
  assert.match(contract, /late charge of \$75/);
  assert.equal(networkCalls.mock.callCount(), 0);
});

test('$75 on $2,600 in New York: the stubbed red rating is returned unchanged', async () => {
  // This only shows the route passes the model's rating through. The rating comes from the stub,
  // so it says nothing about how a real model rates this clause.
  const res = await POST(upload('New York'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.jurisdiction, 'New York');
  assert.deepEqual(body.clauses, STUB_REPLY.clauses);
});

test('every system prompt says common is not lawful, without any jurisdiction rule', async () => {
  await POST(upload('Ontario'));
  const { system } = sentToModel();
  assert.match(system, /Common is not the same as lawful/);
  assert.match(system, /green: Standard and fair — common in contracts of this type, lawful in the signer's jurisdiction/);
  for (const marker of ['238-a', 'New York', '$50']) assert.ok(!system.includes(marker), `system prompt leaks ${marker}`);
});

for (const jurisdiction of ['Ontario', 'BC', 'California']) {
  test(`a ${jurisdiction} upload gets no New York rule`, async () => {
    const res = await POST(upload(jurisdiction));
    assert.equal(res.status, 200);
    const { user } = sentToModel();
    for (const marker of [...RULE_MARKERS, 'Real Property Law', '$50 or 5%']) {
      assert.ok(!user.includes(marker), `${jurisdiction} request leaks ${marker}`);
    }
    // The lease text is still sent as before.
    assert.match(user, new RegExp(`^Analyze this contract for someone in ${jurisdiction}\\.`));
    assert.match(user, /\n\nCONTRACT:\n/);
  });
}

test('samples get the rule for New York only', async () => {
  await POST(sample('New York'));
  assert.ok(sentToModel().user.includes('§ 238-a'));

  modelCalls.mock.resetCalls();
  await POST(sample('California'));
  assert.ok(!sentToModel().user.includes('238-a'));
  assert.equal(networkCalls.mock.callCount(), 0);
});
