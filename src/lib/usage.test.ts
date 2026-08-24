import { describe, expect, it } from "vitest";
import { getClientIp } from "@/lib/usage";

// getClientIp decides which header to believe, and the order matters for more
// than tidiness. The leftmost x-forwarded-for value is client-supplied, so a
// caller who could steer us to it would pick their own rate-limit bucket (and
// their own visitor_hash). Vercel's x-vercel-forwarded-for is injected at the
// edge and cannot be forged by the client, which is why it wins.
//
// Both the cost defence in CLAUDE.md and the privacy pane's "caching is
// anonymous / we hash the inputs" claim rest on this precedence, so it is
// pinned here rather than left to reading.

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe("getClientIp precedence", () => {
  it("prefers the edge-injected header over both spoofable ones", () => {
    expect(
      getClientIp(
        headers({
          "x-vercel-forwarded-for": "203.0.113.1",
          "x-real-ip": "198.51.100.1",
          "x-forwarded-for": "192.0.2.1",
        }),
      ),
    ).toBe("203.0.113.1");
  });

  it("falls back to x-real-ip when the edge header is absent", () => {
    expect(
      getClientIp(
        headers({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.1" }),
      ),
    ).toBe("198.51.100.1");
  });

  it("falls back to x-forwarded-for last", () => {
    expect(getClientIp(headers({ "x-forwarded-for": "192.0.2.1" }))).toBe(
      "192.0.2.1",
    );
  });

  it("returns null when no client IP header is present", () => {
    // Not a fallback to some shared sentinel: the agent route skips rate
    // limiting entirely on null, so header-less requests are not bucketed
    // together into shared false 429s.
    expect(getClientIp(headers({}))).toBeNull();
  });
});

describe("getClientIp parsing", () => {
  it("takes the first entry of a comma-separated chain", () => {
    expect(
      getClientIp(headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1, 10.0.0.2" })),
    ).toBe("192.0.2.1");
  });

  it("trims surrounding whitespace", () => {
    expect(getClientIp(headers({ "x-real-ip": "  198.51.100.1  " }))).toBe(
      "198.51.100.1",
    );
    expect(
      getClientIp(headers({ "x-vercel-forwarded-for": " 203.0.113.1 , 10.0.0.1" })),
    ).toBe("203.0.113.1");
  });

  it("treats an empty or whitespace-only value as absent", () => {
    // An empty string must not become a rate-limit bucket key shared by every
    // such request.
    expect(getClientIp(headers({ "x-real-ip": "   " }))).toBeNull();
    expect(getClientIp(headers({ "x-forwarded-for": "" }))).toBeNull();
    expect(getClientIp(headers({ "x-vercel-forwarded-for": " , 10.0.0.1" }))).toBeNull();
    expect(getClientIp(headers({ "x-forwarded-for": " , 10.0.0.1" }))).toBeNull();
  });
});
