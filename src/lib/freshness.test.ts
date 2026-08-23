import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredThresholdMinutes, isKillSwitchEngaged } from "./freshness";

// The two env-driven gates that decide whether the site renders at all
// (LUL 2.3 self-policing + the manual kill switch). Pure parse logic — no
// Supabase involved — so the whole matrix runs against stubbed env vars.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuredThresholdMinutes", () => {
  it("defaults to 60 when unset", () => {
    vi.stubEnv("BBB_STALENESS_MINUTES", undefined);
    expect(configuredThresholdMinutes()).toBe(60);
  });

  it("honours a valid positive override", () => {
    vi.stubEnv("BBB_STALENESS_MINUTES", "360");
    expect(configuredThresholdMinutes()).toBe(360);
    vi.stubEnv("BBB_STALENESS_MINUTES", "0.5");
    expect(configuredThresholdMinutes()).toBe(0.5);
  });

  it.each([
    ["empty string", ""],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-30"],
    ["NaN literal", "NaN"],
    ["Infinity", "Infinity"],
  ])("falls back to 60 on %s", (_label, raw) => {
    vi.stubEnv("BBB_STALENESS_MINUTES", raw);
    expect(configuredThresholdMinutes()).toBe(60);
  });

  it("clamps pathological values to 24 h", () => {
    vi.stubEnv("BBB_STALENESS_MINUTES", "10000");
    expect(configuredThresholdMinutes()).toBe(1440);
    vi.stubEnv("BBB_STALENESS_MINUTES", "1e308");
    expect(configuredThresholdMinutes()).toBe(1440);
  });

  it("passes 1440 through unclamped (boundary)", () => {
    vi.stubEnv("BBB_STALENESS_MINUTES", "1440");
    expect(configuredThresholdMinutes()).toBe(1440);
  });
});

describe("isKillSwitchEngaged", () => {
  it("engages (site paused) when BBB_PUBLIC is unset or empty", () => {
    vi.stubEnv("BBB_PUBLIC", undefined);
    expect(isKillSwitchEngaged()).toBe(true);
    vi.stubEnv("BBB_PUBLIC", "");
    expect(isKillSwitchEngaged()).toBe(true);
  });

  it.each(["false", "FALSE", " false ", "0"])(
    "engages on explicit off value %j",
    (raw) => {
      vi.stubEnv("BBB_PUBLIC", raw);
      expect(isKillSwitchEngaged()).toBe(true);
    },
  );

  it.each(["true", "1", "yes", "anything-else"])(
    "stays live on %j",
    (raw) => {
      vi.stubEnv("BBB_PUBLIC", raw);
      expect(isKillSwitchEngaged()).toBe(false);
    },
  );
});
