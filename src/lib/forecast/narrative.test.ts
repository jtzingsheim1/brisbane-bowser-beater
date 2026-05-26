import { describe, expect, it } from "vitest";
import { buildNarrative } from "./narrative";
import { getCycleParams } from "./params";
import type { ProjectionResult } from "./types";

const params = getCycleParams();

function result(overrides: Partial<ProjectionResult>): ProjectionResult {
  return {
    anchorDay: "2026-05-25",
    phaseAtAnchor: 0.5,
    troughLevel: 1.8,
    swing: 0.35,
    amplitudeClamped: false,
    nextTroughDay: "2026-06-03",
    nextPeakDay: "2026-06-18",
    rows: [
      { day: "2026-06-03", predictedPrice: 1.82, bandLow: 1.78, bandHigh: 1.86 },
      { day: "2026-06-18", predictedPrice: 2.1, bandLow: 2.05, bandHigh: 2.15 },
    ],
    ...overrides,
  };
}

describe("buildNarrative", () => {
  it("near-trough phase reads as 'near the bottom'", () => {
    expect(buildNarrative(params, result({ phaseAtAnchor: 0.99 }), 1.81)).toContain(
      "near the bottom",
    );
  });

  it("climbing phase reads as 'on the way up'", () => {
    expect(buildNarrative(params, result({ phaseAtAnchor: 0.2 }), 1.95)).toContain(
      "on the way up",
    );
  });

  it("near-peak phase reads as 'near the top'", () => {
    const r = result({ phaseAtAnchor: params.params.peak_phase });
    expect(buildNarrative(params, r, 2.08)).toContain("near the top");
  });

  it("easing phase reads as 'easing down'", () => {
    expect(buildNarrative(params, result({ phaseAtAnchor: 0.7 }), 1.95)).toContain(
      "easing down",
    );
  });

  it("never emits avoid-list (defamation) language", () => {
    const text = buildNarrative(params, result({ phaseAtAnchor: 0.7 }), 1.95).toLowerCase();
    for (const word of ["gouge", "manipulat", "rigged", "greed", "collusion", "scam"]) {
      expect(text).not.toContain(word);
    }
  });
});
