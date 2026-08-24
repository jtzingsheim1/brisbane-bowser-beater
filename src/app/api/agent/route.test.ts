import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The agent route is the one endpoint that can spend money, and every promise
// docs/abuse-audit.md makes about bounding that spend lives in the validation
// branches below -- each one returns before any Anthropic call. They were
// previously untested, so a refactor could have removed a cap silently.
//
// The model call itself is mocked: what is under test is which requests are
// refused, and that a refused request never reaches the provider.

const { streamTextMock, createAnthropicMock, rateLimitMock, getCachedPlanMock } =
  vi.hoisted(() => ({
    streamTextMock: vi.fn(),
    createAnthropicMock: vi.fn(),
    rateLimitMock: vi.fn(),
    getCachedPlanMock: vi.fn(),
  }));

vi.mock("ai", () => ({
  streamText: (...args: unknown[]) => {
    streamTextMock(...args);
    return { toUIMessageStreamResponse: () => new Response("stream") };
  },
  convertToModelMessages: async (m: unknown) => m,
  stepCountIs: (n: number) => n,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (id: string) => ({ id }),
  createAnthropic: (config: unknown) => {
    createAnthropicMock(config);
    return (id: string) => ({ id });
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAgentRateLimit: (ip: string) => rateLimitMock(ip),
}));

vi.mock("@/lib/agent/plan-cache", () => ({
  getCachedPlan: (h: string) => getCachedPlanMock(h),
  putCachedPlan: vi.fn().mockResolvedValue(undefined),
  hashSituation: () => "test-hash",
  cachedPlanResponse: () => new Response("cached"),
}));

vi.mock("@/lib/agent/tools", () => ({
  getForecastTool: {},
  getRecentHistoryTool: {},
}));

vi.mock("@/lib/agent/system-prompt", () => ({ SYSTEM_PROMPT: "system" }));

const { POST } = await import("./route");

/** A request body that passes every check, so each test varies one thing. */
function message(text: string) {
  return { id: "1", role: "user", parts: [{ type: "text", text }] };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "sk-ant-server-key";
  rateLimitMock.mockResolvedValue({ allowed: true });
  getCachedPlanMock.mockResolvedValue(null);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe("the happy path still reaches the model", () => {
  // Without this, every rejection test below could pass on a route that
  // refuses everything.
  it("streams a response for a well-formed request", async () => {
    const res = await POST(post({ messages: [message("hi")] }));
    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledOnce();
  });
});

describe("message-shape validation", () => {
  it.each([
    ["missing messages", {}],
    ["messages not an array", { messages: "nope" }],
    ["empty messages", { messages: [] }],
    ["null messages", { messages: null }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});

describe("conversation-size caps", () => {
  it("allows exactly the message limit", async () => {
    const messages = Array.from({ length: 20 }, () => message("hi"));
    expect((await POST(post({ messages }))).status).toBe(200);
  });

  it("rejects one message over the limit", async () => {
    const messages = Array.from({ length: 21 }, () => message("hi"));
    const res = await POST(post({ messages }));
    expect(res.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("allows text exactly at the character cap", async () => {
    const messages = [message("x".repeat(16_000))];
    expect((await POST(post({ messages }))).status).toBe(200);
  });

  it("rejects text one character over the cap", async () => {
    const messages = [message("x".repeat(16_001))];
    const res = await POST(post({ messages }));
    expect(res.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("sums characters across messages rather than per message", async () => {
    // Ten messages under the cap individually, over it together.
    const messages = Array.from({ length: 10 }, () => message("x".repeat(2_000)));
    const res = await POST(post({ messages }));
    expect(res.status).toBe(400);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("ignores non-text parts when measuring size", async () => {
    const messages = [
      { id: "1", role: "user", parts: [{ type: "step-start" }, { type: "text", text: "hi" }] },
    ];
    expect((await POST(post({ messages }))).status).toBe(200);
  });
});

describe("BYO-key handling", () => {
  it("rejects a key with the wrong prefix without calling the provider", async () => {
    // The route must not be usable as a free oracle for probing whether an
    // arbitrary string is a valid Anthropic key.
    const res = await POST(post({ messages: [message("hi")] }, { "x-anthropic-key": "nope" }));
    expect(res.status).toBe(400);
    expect(createAnthropicMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("rejects an over-long key", async () => {
    const key = `sk-ant-${"x".repeat(200)}`;
    const res = await POST(post({ messages: [message("hi")] }, { "x-anthropic-key": key }));
    expect(res.status).toBe(400);
    expect(createAnthropicMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed key and bills it instead of the server key", async () => {
    const key = "sk-ant-caller-key";
    const res = await POST(post({ messages: [message("hi")] }, { "x-anthropic-key": key }));
    expect(res.status).toBe(200);
    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: key });
  });

  it("works when the server has no key of its own", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(
      post({ messages: [message("hi")] }, { "x-anthropic-key": "sk-ant-caller-key" }),
    );
    expect(res.status).toBe(200);
  });

  it("ignores a whitespace-only key header and uses the server key", async () => {
    const res = await POST(post({ messages: [message("hi")] }, { "x-anthropic-key": "   " }));
    expect(res.status).toBe(200);
    expect(createAnthropicMock).not.toHaveBeenCalled();
  });
});

describe("unconfigured server", () => {
  it("returns 503 when no key is available from either source", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(post({ messages: [message("hi")] }));
    expect(res.status).toBe(503);
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After when the limiter refuses", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const res = await POST(
      post({ messages: [message("hi")] }, { "x-real-ip": "203.0.113.1" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("skips the limiter entirely when no client IP is present", async () => {
    // Bucketing header-less requests together would cause shared false 429s.
    const res = await POST(post({ messages: [message("hi")] }));
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("limits on the edge-injected IP when several headers are present", async () => {
    await POST(
      post(
        { messages: [message("hi")] },
        { "x-vercel-forwarded-for": "203.0.113.1", "x-forwarded-for": "192.0.2.1" },
      ),
    );
    expect(rateLimitMock).toHaveBeenCalledWith("203.0.113.1");
  });
});

describe("plan cache", () => {
  it("replays a cached plan without calling the model", async () => {
    getCachedPlanMock.mockResolvedValue({ text: "cached plan" });
    const res = await POST(post({ messages: [message("hi")] }));
    expect(res.status).toBe(200);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("falls back to a live call when the cache read fails", async () => {
    getCachedPlanMock.mockRejectedValue(new Error("redis down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(post({ messages: [message("hi")] }));
    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("model-call bounds", () => {
  it("caps output tokens and agent steps on every call", async () => {
    await POST(post({ messages: [message("hi")] }));
    const config = streamTextMock.mock.calls[0][0] as {
      maxOutputTokens: number;
      stopWhen: number;
    };
    expect(config.maxOutputTokens).toBe(1500);
    expect(config.stopWhen).toBe(6);
  });
});
