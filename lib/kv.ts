import { Redis } from '@upstash/redis';

// Quota counters and the sample cache live in Upstash Redis. The Vercel Marketplace integration
// injects KV_REST_API_URL / KV_REST_API_TOKEN; Upstash's own UPSTASH_REDIS_REST_* names work too.
// Each pair is read whole so a URL from one database is never combined with another's token.
function credentials(): { url: string; token: string } | null {
  const env = process.env;
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
  }
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  }
  return null;
}

let client: Redis | undefined;

// Created on first use, not at import, so missing configuration surfaces as an error inside the
// caller's try/catch: quota checks deny on Vercel and the sample cache treats it as a miss.
export function getRedis(): Redis {
  if (client) return client;
  const creds = credentials();
  if (!creds) {
    throw new Error('Redis is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN');
  }
  // Same options @vercel/kv used: Next.js recommends the default fetch cache mode, and
  // auto-pipelining batches concurrent commands into one request.
  client = new Redis({ ...creds, cache: 'default', enableAutoPipelining: true });
  return client;
}
