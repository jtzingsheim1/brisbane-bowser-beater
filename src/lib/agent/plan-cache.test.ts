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
    // Order matters — the notice must lead, not trail.
    expect(body.indexOf("saved plan from earlier today")).toBeLessThan(
      body.indexOf("Fill on Tuesday."),
    );
  });

  it("does not claim the cached plan matches the current forecast", async () => {
    // The cache is keyed by UTC day, but the forecast batch regenerates at
    // 06:30 AEST — inside that day. Claiming "same forecast" would be false
    // every morning.
    const body = await cachedPlanResponse("Fill on Tuesday.").text();
    expect(body).not.toContain("same forecast");
  });
});

describe("hashSituation with cached replays", () => {
  it("hashes the same whether turn 1 was a cache hit or a live generation", () => {
    const live = [msg("user", "chip A"), msg("assistant", "Fill Tuesday.")];
    const replayed = [
      msg("user", "chip A"),
      msg(
        "assistant",
        "*(Using a saved plan from earlier today for the same situation.)*\n\nFill Tuesday.",
      ),
    ];
    expect(hashSituation(replayed)).toBe(hashSituation(live));
  });
});
