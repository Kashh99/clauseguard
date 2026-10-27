// Run with: npm test
// Proves every real model call (uploads and sample cache misses) passes the daily caps first, that
// cache hits are free, and that on Vercel a missing or failing quota store blocks the call.
// Every test loads its own copy of the route, so each passes alone or in any order.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';

const KV_URL = 'https://kv.test.invalid';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = 'test-token-not-real';
delete process.env.ANTHROPIC_BASE_URL;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.CLAUSEGUARD_TEST_MODE;

// A fresh module instance per test: the route memoizes sample results in memory, and a shared
// instance would let one test's analysis turn another test's cache miss into a hit.
const ROUTE_URL = new URL('../app/api/analyze/route.ts', import.meta.url).href;
let instance = 0;
const loadRoute = async () => (await import(`${ROUTE_URL}?instance=${++instance}`)).POST;

const today = () => new Date().toISOString().slice(0, 10);
const globalKey = () => `analyses:${today()}`;
const clientCounter = ip => `analyses:${today()}:${ip}`;

// In-memory Upstash REST API behind the mocked fetch: just the commands the app sends.
const kvStore = new Map();
let kvFailure = null; // an error reply to return for every KV request, simulating an outage
let kvDelayMs = 0;

function runCommand([name, ...args]) {
  const cmd = name.toLowerCase();
  const [key] = args;
  if (cmd === 'get') return kvStore.get(key) ?? null;
  if (cmd === 'set') { kvStore.set(key, args[1]); return 'OK'; }
  if (cmd === 'incr' || cmd === 'decr') {
    const value = Number(kvStore.get(key) ?? 0) + (cmd === 'incr' ? 1 : -1);
    kvStore.set(key, String(value));
    return value;
  }
  if (cmd === 'expire') return 1;
  if (cmd === 'eval') { // REFUND_SCRIPT: decrement only a positive counter
    const counter = args[2];
    const value = kvStore.has(counter) ? Number(kvStore.get(counter)) : null;
    if (value !== null && value > 0) { kvStore.set(counter, String(value - 1)); return value - 1; }
    return value ?? 0;
  }
  throw new Error(`fake KV: unsupported command ${cmd}`);
}

async function fakeKvFetch(url, init) {
  if (kvDelayMs) await new Promise(r => setTimeout(r, kvDelayMs));
  if (kvFailure) return Response.json({ error: kvFailure }, { status: 500 });
  const encode = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : v);
  const reply = command => {
    try { return { result: encode(runCommand(command)) }; } catch (e) { return { error: e.message }; }
  };
  const body = JSON.parse(init.body);
  const path = new URL(url).pathname;
  return Response.json(path === '/pipeline' || path === '/multi-exec' ? body.map(reply) : reply(body));
}

const MODEL_REPLY = {
  summary: 'stubbed analysis',
  contractType: 'Lease Agreement',
  clauses: [{ title: 'Rent', excerpt: 'stub', riskLevel: 'green', explanation: 'stub', negotiationTip: null }],
};

let modelCalls;
let modelDelayMs = 0;
let foreignFetches;
let POST;

beforeEach(async () => {
  POST = await loadRoute();
  kvStore.clear();
  kvFailure = null;
  kvDelayMs = 0;
  modelDelayMs = 0;
  foreignFetches = 0;
  modelCalls = mock.method(Anthropic.Messages.prototype, 'create', async () => {
    if (modelDelayMs) await new Promise(r => setTimeout(r, modelDelayMs));
    return { content: [{ type: 'text', text: JSON.stringify(MODEL_REPLY) }], stop_reason: 'end_turn' };
  });
  mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith(KV_URL)) return fakeKvFetch(String(url), init);
    foreignFetches++;
    throw new Error(`unexpected network call to ${url}`);
  });
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.VERCEL;
  assert.equal(foreignFetches, 0, 'no network call other than to the fake KV store');
});

function sampleRequest(jurisdiction, ip = '203.0.113.1') {
  const form = new FormData();
  form.append('sample', 'ontario-lease');
  form.append('jurisdiction', jurisdiction);
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form, headers: { 'x-real-ip': ip } });
}

function uploadRequest(ip = '203.0.113.1') {
  const text = 'Residential lease agreement';
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
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
  const form = new FormData();
  form.append('file', new File([Buffer.from(pdf, 'latin1')], 'lease.pdf', { type: 'application/pdf' }));
  form.append('jurisdiction', 'Ontario');
  return new Request('http://localhost/api/analyze', { method: 'POST', body: form, headers: { 'x-real-ip': ip } });
}

const counters = ip => ({ global: Number(kvStore.get(globalKey()) ?? 0), visitor: Number(kvStore.get(clientCounter(ip)) ?? 0) });
const sampleCacheKeys = () => [...kvStore.keys()].filter(k => k.startsWith('sample:'));


test('a sample cache miss passes the caps, charges the visitor and global counters, then caches', async () => {
  const res = await POST(sampleRequest('Ontario'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, 'stubbed analysis');
  assert.equal(modelCalls.mock.callCount(), 1);
  assert.deepEqual(counters('203.0.113.1'), { global: 1, visitor: 1 });
  assert.equal(sampleCacheKeys().length, 1, 'result written to the KV cache');

  // Same sample again, from another visitor: served from memory, no new charge or model call.
  const again = await POST(sampleRequest('Ontario', '198.51.100.9'));
  assert.equal(again.status, 200);
  assert.equal(modelCalls.mock.callCount(), 1);
  assert.deepEqual(counters('198.51.100.9'), { global: 1, visitor: 0 });
});

test('a sample KV cache hit is free: no quota charged and no model call', async () => {
  // One instance fills the shared KV cache; a second, with an empty memory cache, reads it.
  assert.equal((await POST(sampleRequest('BC', '192.0.2.10'))).status, 200);
  const [cacheKey] = sampleCacheKeys();
  kvStore.set(cacheKey, JSON.stringify({ ...JSON.parse(kvStore.get(cacheKey)), summary: 'from KV cache' }));
  modelCalls.mock.resetCalls();
  const countersBefore = counters('192.0.2.77');

  const freshInstance = await loadRoute();
  const res = await freshInstance(sampleRequest('BC', '192.0.2.77'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, 'from KV cache');
  assert.equal(modelCalls.mock.callCount(), 0);
  assert.deepEqual(counters('192.0.2.77'), countersBefore);
});

test('a sample cache miss is refused when the global cap is exhausted, and the model is not reached', async () => {
  kvStore.set(globalKey(), '20');
  const res = await POST(sampleRequest('California'));
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.code, 'rate_limited');
  assert.match(body.error, /Daily demo limit reached/);
  assert.equal(modelCalls.mock.callCount(), 0);
  assert.deepEqual(counters('203.0.113.1'), { global: 20, visitor: 0 }, 'rejected request gives its slots back');
  assert.equal(sampleCacheKeys().length, 0);
});

test('a sample cache miss is refused when the visitor cap is exhausted, and the model is not reached', async () => {
  kvStore.set(clientCounter('203.0.113.5'), '3');
  const res = await POST(sampleRequest('California', '203.0.113.5'));
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.match(body.error, /used your 3 free analyses/);
  assert.equal(modelCalls.mock.callCount(), 0);
  assert.deepEqual(counters('203.0.113.5'), { global: 0, visitor: 3 });
});

test('an upload is refused when the global cap is exhausted, and the model is not reached', async () => {
  kvStore.set(globalKey(), '20');
  const res = await POST(uploadRequest());
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'rate_limited');
  assert.equal(modelCalls.mock.callCount(), 0);
});

test('on Vercel, a failing quota store blocks sample misses and uploads instead of bypassing the caps', async () => {
  process.env.VERCEL = '1';
  kvFailure = 'ERR max requests limit exceeded';
  for (const req of [sampleRequest('California'), uploadRequest()]) {
    const res = await POST(req);
    const body = await res.json();
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.code, 'quota_unavailable');
  }
  assert.equal(modelCalls.mock.callCount(), 0);
});

test('off Vercel (local dev), a failing quota store does not block', async () => {
  kvFailure = 'ERR max requests limit exceeded';
  const res = await POST(uploadRequest());
  assert.equal(res.status, 200);
  assert.equal(modelCalls.mock.callCount(), 1);
});

test('concurrent misses for one sample make one model call, charged once', async () => {
  modelDelayMs = 30;
  const responses = await Promise.all([
    POST(sampleRequest('California', '203.0.113.21')),
    POST(sampleRequest('California', '203.0.113.22')),
    POST(sampleRequest('California', '203.0.113.23')),
  ]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(modelCalls.mock.callCount(), 1);
  assert.equal(counters('203.0.113.21').global, 1);
});

test('a visitor who joined a refused miss retries on their own quota', async () => {
  kvDelayMs = 10;
  kvStore.set(clientCounter('203.0.113.31'), '3'); // first visitor is out of analyses
  const [refused, served] = await Promise.all([
    POST(sampleRequest('New York', '203.0.113.31')),
    POST(sampleRequest('New York', '203.0.113.32')),
  ]);
  assert.equal(refused.status, 429);
  assert.equal(served.status, 200);
  assert.equal(modelCalls.mock.callCount(), 1);
  assert.deepEqual(counters('203.0.113.32'), { global: 1, visitor: 1 });
});
