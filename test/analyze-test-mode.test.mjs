// Run with: npm test
// Proves test mode answers uploads and samples without touching the model client or the network,
// while upload validation still runs.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

// The route builds its client at import time; it must never get a usable key here.
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.VERCEL;

const { POST } = await import('@/app/api/analyze/route');
const { isTestMode } = await import('@/lib/test-mode');

// Builds a one-page PDF with correct xref offsets; with no text it draws an image instead.
function buildPdf(text) {
  const content = text
    ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
    : 'q 200 0 0 200 72 500 cm /Im1 Do Q';
  const resources = text
    ? '<< /Font << /F1 5 0 R >> >>'
    : '<< /XObject << /Im1 5 0 R >> >>';
  const fifth = text
    ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    : '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\nA~~A\nendstream';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    fifth,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function request(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form });
}

const pdfFile = (bytes, name = 'contract.pdf', type = 'application/pdf') => new File([bytes], name, { type });

let modelCalls;
let networkCalls;

beforeEach(() => {
  modelCalls = mock.method(Anthropic.Messages.prototype, 'create', async () => {
    throw new Error('real model client was called');
  });
  networkCalls = mock.method(globalThis, 'fetch', async () => {
    throw new Error('network was called');
  });
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.CLAUSEGUARD_TEST_MODE;
  delete process.env.VERCEL_ENV;
});

for (const [label, env] of [
  ['VERCEL_ENV=preview', { VERCEL_ENV: 'preview' }],
  ['CLAUSEGUARD_TEST_MODE=1', { CLAUSEGUARD_TEST_MODE: '1' }],
]) {
  test(`${label}: an upload gets a marked mock and the model client is never called`, async () => {
    Object.assign(process.env, env);
    const res = await POST(request({ file: pdfFile(buildPdf('Residential lease agreement')), jurisdiction: 'New York' }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-ClauseGuard-Test-Mode'), 'active');
    assert.equal(body.testMode, true);
    assert.match(body.summary, /^TEST_MODE_ACTIVE/);
    assert.ok(body.clauses.length > 0 && body.clauses.every(c => c.title.startsWith('TEST_MODE_ACTIVE')));
    assert.equal(body.jurisdiction, 'New York');
    assert.equal(modelCalls.mock.callCount(), 0);
    assert.equal(networkCalls.mock.callCount(), 0);
  });

  test(`${label}: a sample gets a marked mock and the model client is never called`, async () => {
    Object.assign(process.env, env);
    const res = await POST(request({ sample: 'ontario-lease', jurisdiction: 'Ontario' }));
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-ClauseGuard-Test-Mode'), 'active');
    assert.equal(body.testMode, true);
    assert.match(body.summary, /^TEST_MODE_ACTIVE/);
    assert.equal(modelCalls.mock.callCount(), 0);
    assert.equal(networkCalls.mock.callCount(), 0, 'no KV cache or API traffic either');
  });
}

test('test mode still validates uploads before mocking', async () => {
  process.env.VERCEL_ENV = 'preview';
  const cases = [
    [{ file: pdfFile('plain text', 'notes.txt', 'text/plain'), jurisdiction: 'Ontario' }, 400, undefined],
    [{ file: pdfFile('%PDF-1.4\nnot really a pdf'), jurisdiction: 'Ontario' }, 422, 'pdf_unreadable'],
    [{ file: pdfFile(buildPdf(null)), jurisdiction: 'Ontario' }, 422, 'pdf_no_text'],
    [{ file: pdfFile(buildPdf('Lease')), jurisdiction: 'Atlantis' }, 400, undefined],
    [{ sample: 'no-such-sample', jurisdiction: 'Ontario' }, 400, undefined],
  ];
  for (const [fields, status, code] of cases) {
    const res = await POST(request(fields));
    const body = await res.json();
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(body.code, code);
    assert.equal(body.testMode, undefined);
  }
  assert.equal(modelCalls.mock.callCount(), 0);
  assert.equal(networkCalls.mock.callCount(), 0);
});

// Control: without test mode the same sample request does reach the model client, so the
// zero-call assertions above would catch a regression.
test('without test mode, a sample does call the model client', async () => {
  modelCalls.mock.mockImplementation(async () => { throw new Error('stubbed model call'); });
  const res = await POST(request({ sample: 'ontario-lease', jurisdiction: 'BC' }));
  assert.equal(res.status, 500);
  assert.equal(modelCalls.mock.callCount(), 1);
});

test('test mode is on for previews and opt-in runs, never for production', () => {
  assert.equal(isTestMode({ VERCEL_ENV: 'preview' }), true);
  assert.equal(isTestMode({ CLAUSEGUARD_TEST_MODE: '1' }), true);
  assert.equal(isTestMode({ VERCEL_ENV: 'production' }), false);
  assert.equal(isTestMode({ VERCEL_ENV: 'production', CLAUSEGUARD_TEST_MODE: '1' }), false);
  assert.equal(isTestMode({ VERCEL_ENV: 'development' }), false);
  assert.equal(isTestMode({}), false);
});
