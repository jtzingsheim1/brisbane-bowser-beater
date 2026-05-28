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

// Returns { allowed: true } permissively when the limiter isn't provisioned.
export async function checkAgentRateLimit(ip: string): Promise<RateLimitResult> {
  const limiter = getLimiter();
  if (!limiter) {
    return { allowed: true, limit: REQUESTS, remaining: REQUESTS, retryAfterSeconds: 0 };
  }
  const { success, limit, remaining, reset } = await limiter.limit(ip);
  return {
    allowed: success,
    limit,
    remaining,
    retryAfterSeconds: Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
  };
}
