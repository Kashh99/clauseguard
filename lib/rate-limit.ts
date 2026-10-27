import { kv } from '@vercel/kv';
import type { VercelKV } from '@vercel/kv';

// Global cap bounds total API spend; the per-client cap stops one visitor from using it all.
const DAILY_LIMIT = 20;
const PER_CLIENT_DAILY_LIMIT = 3;

// Counter keys are per UTC day; two days of TTL covers clock skew around midnight.
const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60;

// Injectable so tests can substitute an in-memory store.
type QuotaStore = Pick<VercelKV, 'multi' | 'eval'>;

// `refundKey` is the client counter this request was charged to, or null when KV is
// unavailable in local dev and nothing was charged.
export type QuotaResult =
  | { ok: false; response: Response }
  | { ok: true; refundKey: string | null };

// Groups IPv6 clients by /64, since a single subscriber usually controls a whole /64.
// On Vercel, x-real-ip is set by the edge network and can't be spoofed by the client.
export function clientKey(headers: Headers): string {
  const ip =
    headers.get('x-real-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    'unknown';
  if (!ip.includes(':')) return ip;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is really an IPv4 client.
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1);

  // Expand "::" so compressed forms (2001:db8::1) group with their full spelling.
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// Charges one analysis to the global and client counters, or returns the 429/503 to send.
export async function consumeQuota(clientId: string, store: QuotaStore = kv): Promise<QuotaResult> {
  const day = new Date().toISOString().slice(0, 10);
  const globalKey = `analyses:${day}`;
  const clientCounterKey = `analyses:${day}:${clientId}`;

  let globalCount: number;
  let clientCount: number;
  try {
    // INCR is atomic, so concurrent requests can't both read the same count and slip past the limit.
    [globalCount, clientCount] = await store
      .multi()
      .incr(globalKey)
      .incr(clientCounterKey)
      .expire(globalKey, QUOTA_TTL_SECONDS)
      .expire(clientCounterKey, QUOTA_TTL_SECONDS)
      .exec<[number, number, number, number]>();
  } catch {
    // Without KV there is no limit. Allow that only for local dev, never on a deployment.
    if (process.env.VERCEL) {
      return {
        ok: false,
        response: Response.json(
          { error: 'Analysis is temporarily unavailable — please try again later.', code: 'quota_unavailable' },
          { status: 503 },
        ),
      };
    }
    return { ok: true, refundKey: null };
  }

  if (globalCount <= DAILY_LIMIT && clientCount <= PER_CLIENT_DAILY_LIMIT) {
    return { ok: true, refundKey: clientCounterKey };
  }

  // Give back the slots this rejected request took, so retries over the limit don't inflate the counts.
  try {
    await store.multi().decr(globalKey).decr(clientCounterKey).exec();
  } catch {
    // Counters only over-count here, which errs on the side of rejecting.
  }

  const response = Response.json(
    {
      error: clientCount > PER_CLIENT_DAILY_LIMIT
        ? `You've used your ${PER_CLIENT_DAILY_LIMIT} free analyses for today. Come back tomorrow, or clone the repo and use your own API key from console.anthropic.com — it only takes 2 minutes.`
        : 'Daily demo limit reached. Come back tomorrow, or clone the repo and use your own API key from console.anthropic.com — it only takes 2 minutes.',
      code: 'rate_limited',
    },
    { status: 429 },
  );
  return { ok: false, response };
}

// Decrements only a positive counter, so a refund can't go negative or recreate an expired key.
// DECR keeps the key's existing TTL.
export const REFUND_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]))
if count and count > 0 then
  return redis.call('DECR', KEYS[1])
end
return count or 0
`;

// Gives back a visitor's slot after a failure they couldn't have caused (timeout, API outage).
// The global counter keeps the slot: it bounds API spend, and the failed call may still have
// used tokens. `refundKey` comes from consumeQuota, so a request that straddles UTC midnight
// refunds the day it was charged to.
export async function refundClientQuota(refundKey: string, store: QuotaStore = kv): Promise<void> {
  try {
    await store.eval(REFUND_SCRIPT, [refundKey], []);
  } catch {
    // KV unavailable — the visitor keeps the over-count, which errs on the side of rejecting.
  }
}
