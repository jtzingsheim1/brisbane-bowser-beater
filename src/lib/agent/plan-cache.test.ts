import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { cachedPlanResponse, hashSituation } from "./plan-cache";

function msg(role: "user" | "assistant", text: string): UIMessage {
  return { id: "x", role, parts: [{ type: "text", text }] } as UIMessage;
}

describe("hashSituation", () => {
  it("is deterministic for identical messages", () => {
    expect(hashSituation([msg("user", "hello")])).toBe(
      hashSituation([msg("user", "hello")]),
    );
  });

  it("differs when the text differs", () => {
    expect(hashSituation([msg("user", "a")])).not.toBe(
      hashSituation([msg("user", "b")]),
    );
  });

  it("differs when the role differs", () => {
    expect(hashSituation([msg("user", "x")])).not.toBe(
      hashSituation([msg("assistant", "x")]),
    );
  });

  it("returns a 64-char sha256 hex string", () => {
    expect(hashSituation([msg("user", "x")])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cachedPlanResponse", () => {
  it("prefixes the replay with the saved-plan notice", async () => {
    const body = await cachedPlanResponse("Fill on Tuesday.").text();
    // The stream body is SSE-framed JSON; both the notice and the plan text
    // ride inside text-delta events.
    expect(body).toContain("saved plan from earlier today");
    expect(body).toContain("Fill on Tuesday.");
  });
});
