import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Per-IP rate limits, backed by Upstash Redis when provisioned; a no-op that
// allows everything when the env vars are absent (local dev, or before the
// Upstash marketplace integration is wired). Two buckets share one Redis:
//   - agent (cost defence layer 2, see CLAUDE.md "Cost architecture") — the
//     Anthropic hard spend cap is the ultimate backstop regardless.
//   - tips — Stripe Checkout session creation. Creating sessions is free but
//     unmetered spam would litter the Stripe dashboard and burn function time.

type BucketConfig = {
  prefix: string;
  requests: number; // requests per IP…
  window: Parameters<typeof Ratelimit.slidingWindow>[1]; // …per this sliding window
};

const AGENT: BucketConfig = { prefix: "bbb:agent", requests: 10, window: "60 s" };
const TIPS: BucketConfig = { prefix: "bbb:tips", requests: 5, window: "60 s" };

let redisResolved = false;
let cachedRedis: Redis | null = null;

function getRedis(): Redis | null {
  if (redisResolved) return cachedRedis;
  redisResolved = true;
  // Accept either the native Upstash names or the KV_* names that Vercel's
  // Upstash Marketplace integration injects (KV_REST_API_URL / _TOKEN are the
  // REST pair — not the redis:// KV_URL/REDIS_URL, which this client can't use,
  // nor the read-only token, since the limiter writes counters).
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    cachedRedis = null; // unprovisioned → limiters disabled
    return null;
  }
  cachedRedis = new Redis({ url, token });
  return cachedRedis;
}

const limiters = new Map<string, Ratelimit>();

function getLimiter(config: BucketConfig): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;
  let limiter = limiters.get(config.prefix);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.requests, config.window),
      prefix: config.prefix,
      analytics: false,
    });
    limiters.set(config.prefix, limiter);
  }
  return limiter;
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

function permissive(config: BucketConfig): RateLimitResult {
  return {
    allowed: true,
    limit: config.requests,
    remaining: config.requests,
    retryAfterSeconds: 0,
  };
}

// Enforces normally when Upstash is provisioned and reachable. Two distinct
// permissive paths, deliberately kept separate:
//   1. Unprovisioned (no env vars) — local dev / before the Upstash integration
//      is wired. The limiter simply doesn't exist, so every request is allowed.
//   2. FAIL OPEN — the limiter exists but the Redis call errors (archived DB,
//      transient outage, network blip). We allow *that* request rather than
//      500 the route, and log it so the degradation is visible. This is scoped
//      to an actual thrown error — the normal enforcement path is untouched, so
//      a healthy limiter still returns 429s. The Anthropic hard spend cap
//      (cost defence layer 1) remains the backstop while Redis is down.
async function checkRateLimit(
  config: BucketConfig,
  ip: string,
): Promise<RateLimitResult> {
  const limiter = getLimiter(config);
  if (!limiter) {
    return permissive(config); // path 1: unprovisioned
  }
  try {
    const { success, limit, remaining, reset } = await limiter.limit(ip);
    return {
      allowed: success,
      limit,
      remaining,
      retryAfterSeconds: Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
    };
  } catch (error) {
    // path 2: fail open on a genuine limiter error only
    console.error(
      `[rate-limit] ${config.prefix} limiter unreachable; failing open for this request`,
      error,
    );
    return permissive(config);
  }
}

export function checkAgentRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(AGENT, ip);
}

export function checkTipRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit(TIPS, ip);
}
