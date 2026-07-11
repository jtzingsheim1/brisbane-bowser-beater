import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Per-IP rate limit for the agent route (cost defence layer 2, see CLAUDE.md
// "Cost architecture"). Backed by Upstash Redis when provisioned; a no-op that
// allows everything when the env vars are absent (local dev, or before the
// Upstash marketplace integration is wired). The Anthropic hard spend cap is
// the ultimate backstop regardless.

const REQUESTS = 10; // requests…
const WINDOW = "60 s"; // …per IP per this sliding window

let cached: Ratelimit | null = null;
let resolved = false;

function getLimiter(): Ratelimit | null {
  if (resolved) return cached;
  resolved = true;
  // Accept either the native Upstash names or the KV_* names that Vercel's
  // Upstash Marketplace integration injects (KV_REST_API_URL / _TOKEN are the
  // REST pair — not the redis:// KV_URL/REDIS_URL, which this client can't use,
  // nor the read-only token, since the limiter writes counters).
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    cached = null; // unprovisioned → limiter disabled
    return null;
  }
  cached = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(REQUESTS, WINDOW),
    prefix: "bbb:agent",
    analytics: false,
  });
  return cached;
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

const PERMISSIVE: RateLimitResult = {
  allowed: true,
  limit: REQUESTS,
  remaining: REQUESTS,
  retryAfterSeconds: 0,
};

// Enforces normally when Upstash is provisioned and reachable. Two distinct
// permissive paths, deliberately kept separate:
//   1. Unprovisioned (no env vars) — local dev / before the Upstash integration
//      is wired. The limiter simply doesn't exist, so every request is allowed.
//   2. FAIL OPEN — the limiter exists but the Redis call errors (archived DB,
//      transient outage, network blip). We allow *that* request rather than
//      500 the agent, and log it so the degradation is visible. This is scoped
//      to an actual thrown error — the normal enforcement path is untouched, so
//      a healthy limiter still returns 429s. The Anthropic hard spend cap
//      (cost defence layer 1) remains the backstop while Redis is down.
export async function checkAgentRateLimit(ip: string): Promise<RateLimitResult> {
  const limiter = getLimiter();
  if (!limiter) {
    return PERMISSIVE; // path 1: unprovisioned
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
      "[rate-limit] limiter unreachable; failing open for this request",
      error,
    );
    return PERMISSIVE;
  }
}
