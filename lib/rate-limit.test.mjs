// Run with: npm test
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { consumeQuota, refundClientQuota } from './rate-limit.ts';

// In-memory stand-in for the KV commands rate-limit.ts uses. `eval` mirrors REFUND_SCRIPT,
// which was checked separately against Redis's Lua semantics.
function createStore() {
  const values = new Map();
  const ttls = new Map();
  const commands = {
    incr: key => { const v = (values.get(key) ?? 0) + 1; values.set(key, v); return v; },
    decr: key => { const v = (values.get(key) ?? 0) - 1; values.set(key, v); return v; },
    expire: (key, seconds) => { ttls.set(key, seconds); return 1; },
  };
  return {
    values,
    ttls,
    multi() {
      const queued = [];
      const chain = {
        exec: async () => queued.map(([name, args]) => commands[name](...args)),
      };
      for (const name of Object.keys(commands)) {
        chain[name] = (...args) => { queued.push([name, args]); return chain; };
      }
      return chain;
    },
    async eval(_script, [key]) {
      const count = values.get(key);
      if (count !== undefined && count > 0) return commands.decr(key);
      return count ?? 0;
    },
  };
}

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T23:59:59.900Z') }));
afterEach(() => mock.timers.reset());

test('a request accepted before UTC midnight refunds that day, not the next', async () => {
  const store = createStore();

  const quota = await consumeQuota('203.0.113.7', store);
  assert.equal(quota.ok, true);
  assert.equal(quota.refundKey, 'analyses:2026-10-27:203.0.113.7');
  const ttlBefore = store.ttls.get(quota.refundKey);

  // The Claude call fails after midnight.
  mock.timers.setTime(Date.parse('2026-10-28T00:00:00.200Z'));
  await refundClientQuota(quota.refundKey, store);

  assert.equal(store.values.get('analyses:2026-10-27:203.0.113.7'), 0);
  assert.equal(store.values.has('analyses:2026-10-28:203.0.113.7'), false, 'next day must not be touched');
  assert.equal(store.values.get('analyses:2026-10-27'), 1, 'global counter keeps the slot');
  assert.equal(store.ttls.get(quota.refundKey), ttlBefore, 'refund must not change the expiry');
});

test('refunds never take a counter below zero or recreate an expired key', async () => {
  const store = createStore();
  const quota = await consumeQuota('203.0.113.7', store);

  await refundClientQuota(quota.refundKey, store);
  await refundClientQuota(quota.refundKey, store);
  assert.equal(store.values.get(quota.refundKey), 0);

  store.values.delete(quota.refundKey);
  await refundClientQuota(quota.refundKey, store);
  assert.equal(store.values.has(quota.refundKey), false);
});

test('on Vercel, missing quota storage denies the request instead of skipping the caps', async () => {
  // The real default store, with no Redis credentials configured.
  for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    delete process.env[name];
  }
  process.env.VERCEL = '1';
  try {
    const quota = await consumeQuota('203.0.113.7');
    assert.equal(quota.ok, false);
    assert.equal(quota.status, 503);
    assert.equal(quota.code, 'quota_unavailable');
  } finally {
    delete process.env.VERCEL;
  }
  // Local dev without Redis still runs, and nothing is charged that could be refunded.
  assert.deepEqual(await consumeQuota('203.0.113.7'), { ok: true, refundKey: null });
});

test('an error reply in place of a counter value is treated as unavailable storage', async () => {
  const store = createStore();
  store.multi = () => ({ incr() { return this; }, expire() { return this; }, exec: async () => ['ERR', 'ERR', 1, 1] });
  process.env.VERCEL = '1';
  try {
    const quota = await consumeQuota('203.0.113.7', store);
    assert.equal(quota.ok, false);
    assert.equal(quota.status, 503);
  } finally {
    delete process.env.VERCEL;
  }
});
