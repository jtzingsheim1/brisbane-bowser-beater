import { describe, expect, it } from "vitest";
import { getCycleParams, validateCycleParams } from "@/lib/forecast/params";
import type { CycleParams } from "@/lib/forecast/types";

// cycle_params.json is the contract between the offline Python pipeline and
// this TS code, and it is re-authored by hand every quarterly re-fit. These
// cases pin what the validator refuses, so a malformed template fails loudly
// at load rather than silently projecting a wrong forecast.
//
// The happy path is covered by the module importing the committed artifact at
// load time -- if that ever stopped validating, every test in the suite would
// fail on import.

/** A structurally valid template, cloned from the committed artifact. */
function valid(): CycleParams {
  return structuredClone(getCycleParams());
}

describe("validateCycleParams accepts the committed artifact", () => {
  it("round-trips the real params", () => {
    expect(validateCycleParams(valid())).toEqual(getCycleParams());
  });
});

describe("validateCycleParams rejects schema drift", () => {
  it("refuses an unsupported schema_version", () => {
    const p = valid();
    p.schema_version = 2;
    expect(() => validateCycleParams(p)).toThrow(/schema_version 2 unsupported/);
  });

  it("refuses a missing schema_version", () => {
    const p = valid();
    delete (p as Partial<CycleParams>).schema_version;
    expect(() => validateCycleParams(p)).toThrow(/schema_version/);
  });
});

describe("validateCycleParams rejects malformed shape arrays", () => {
  it("refuses mismatched phase and price lengths", () => {
    const p = valid();
    p.shape.normalised_price = p.shape.normalised_price.slice(0, -1);
    expect(() => validateCycleParams(p)).toThrow(/shape arrays/);
  });

  it("refuses a mismatched band_std length", () => {
    const p = valid();
    p.shape.band_std = p.shape.band_std.slice(0, -1);
    expect(() => validateCycleParams(p)).toThrow(/shape arrays/);
  });

  it("refuses a shape too short to interpolate between", () => {
    const p = valid();
    p.shape.phase = [0];
    p.shape.normalised_price = [0];
    p.shape.band_std = [0];
    expect(() => validateCycleParams(p)).toThrow(/shape arrays/);
  });
});

describe("validateCycleParams rejects non-positive cycle parameters", () => {
  // A zero or negative period/amplitude would not throw downstream -- it would
  // produce a flat or inverted projection, which is worse than a hard failure.
  it.each([
    ["period_days", 0],
    ["period_days", -1],
    ["amplitude_dollars", 0],
    ["amplitude_dollars", -0.35],
  ] as const)("refuses %s = %s", (field, value) => {
    const p = valid();
    p.params[field] = value;
    expect(() => validateCycleParams(p)).toThrow(/non-positive period or amplitude/);
  });

  it("refuses a NaN period", () => {
    const p = valid();
    p.params.period_days = Number.NaN;
    expect(() => validateCycleParams(p)).toThrow(/non-positive period or amplitude/);
  });
});

describe("validateCycleParams rejects malformed dates", () => {
  it("refuses a missing anchor date", () => {
    const p = valid();
    delete (p as Partial<CycleParams>).post_anomaly_anchor_date;
    expect(() => validateCycleParams(p)).toThrow(/post_anomaly_anchor_date/);
  });

  it.each(["2026-5-01", "01-05-2026", "not-a-date", ""])(
    "refuses anchor date %o",
    (date) => {
      const p = valid();
      p.post_anomaly_anchor_date = date;
      expect(() => validateCycleParams(p)).toThrow(/post_anomaly_anchor_date/);
    },
  );

  it("refuses a missing anomaly_notes block", () => {
    // Hand-authored on every re-fit (see CLAUDE.md), so the likeliest thing to
    // be forgotten.
    const p = valid();
    delete (p as Partial<CycleParams>).anomaly_notes;
    expect(() => validateCycleParams(p)).toThrow(/anomaly_notes/);
  });

  it("refuses a malformed anomaly window date", () => {
    const p = valid();
    p.anomaly_notes.window.end = "2026-4-30";
    expect(() => validateCycleParams(p)).toThrow(/anomaly_notes/);
  });

  it("refuses a malformed anomaly peak date", () => {
    const p = valid();
    p.anomaly_notes.peak.date = "";
    expect(() => validateCycleParams(p)).toThrow(/anomaly_notes/);
  });
});
