import { afterEach, describe, expect, it, vi } from "vitest";
import { stalenessThresholdMinutes } from "../mcp/src/data";
import { configuredThresholdMinutes } from "@/lib/freshness";

// The website and the MCP server each gate licensed data on the same
// BBB_STALENESS_MINUTES setting (licence cl 2.3 currency), and the docs tell
// operators to set one value for both. The subproject can't import the site's
// code, so the parse lives twice; this holds the two copies to the same
// answer for every kind of input, so a changed default or clamp on one side
// fails here instead of drifting silently.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("staleness threshold parity (website vs MCP server)", () => {
  it.each([
    undefined,
    "",
    "abc",
    "0",
    "-5",
    "0.5",
    "60",
    "360",
    "1440",
    "2000",
    "1e308",
    "Infinity",
    "NaN",
  ])("agrees for BBB_STALENESS_MINUTES=%s", (raw) => {
    vi.stubEnv("BBB_STALENESS_MINUTES", raw);
    expect(stalenessThresholdMinutes()).toBe(configuredThresholdMinutes());
  });
});
