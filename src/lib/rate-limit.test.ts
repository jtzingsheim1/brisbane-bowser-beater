import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rate-limit.ts memoises its Redis resolution at module level, so every case
// re-imports a fresh module copy after arranging the env. The Upstash SDKs
// are mocked: what's under test is our env resolution (native UPSTASH_* names
// vs the KV_* names Vercel's marketplace integration injects), the
// unprovisioned permissive path, and the fail-open-on-error path — the cost
// defence layer promised in CLAUDE.md, previously untested.

const { redisCtor, limitFn } = vi.hoisted(() => ({
  redisCtor: vi.fn(),
  limitFn: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(config: unknown) {
      redisCtor(config);
    }
  },
}));

vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    static slidingWindow(requests: number, window: string) {
      return { requests, window };
    }
    limit = limitFn;
  },
}));

const ENV_KEYS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  redisCtor.mockReset();
  limitFn.mockReset();
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function freshModule() {
  return import("./rate-limit");
}

describe("rate-limit env resolution", () => {
  it("allows everything when unprovisioned (no env vars)", async () => {
    const { checkAgentRateLimit } = await freshModule();
    const result = await checkAgentRateLimit("1.2.3.4");
    expect(result).toEqual({
      allowed: true,
      limit: 10,
      remaining: 10,
      retryAfterSeconds: 0,
    });
    expect(redisCtor).not.toHaveBeenCalled();
  });

  it("uses the native UPSTASH_* pair when set", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://native.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "native-token";
    limitFn.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 1000,
    });
    const { checkAgentRateLimit } = await freshModule();
    await checkAgentRateLimit("1.2.3.4");
    expect(redisCtor).toHaveBeenCalledWith({
      url: "https://native.example",
      token: "native-token",
    });
  });

  it("falls back to the KV_* pair from the marketplace integration", async () => {
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
    limitFn.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 1000,
    });
    const { checkAgentRateLimit } = await freshModule();
    await checkAgentRateLimit("1.2.3.4");
    expect(redisCtor).toHaveBeenCalledWith({
      url: "https://kv.example",
      token: "kv-token",
    });
  });

  it("prefers UPSTASH_* when both pairs are set", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://native.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "native-token";
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
    limitFn.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 1000,
    });
    const { checkAgentRateLimit } = await freshModule();
    await checkAgentRateLimit("1.2.3.4");
    expect(redisCtor).toHaveBeenCalledWith({
      url: "https://native.example",
      token: "native-token",
    });
  });

  it("stays disabled when a pair is incomplete (url without token)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://native.example";
    const { checkAgentRateLimit } = await freshModule();
    const result = await checkAgentRateLimit("1.2.3.4");
    expect(result.allowed).toBe(true);
    expect(redisCtor).not.toHaveBeenCalled();
  });
});

describe("rate-limit enforcement mapping", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://native.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "native-token";
  });

  it("maps a denial to allowed=false with retry seconds", async () => {
    limitFn.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 30_000,
    });
    const { checkAgentRateLimit } = await freshModule();
    const result = await checkAgentRateLimit("1.2.3.4");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("fails open (allows the request) when the limiter throws", async () => {
    limitFn.mockRejectedValue(new Error("redis unreachable"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { checkAgentRateLimit } = await freshModule();
    const result = await checkAgentRateLimit("1.2.3.4");
    expect(result.allowed).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
