import { describe, expect, it } from "vitest";
import cycleParams from "../../../analysis/output/cycle_params.json";
import {
  anomalyWindow,
  buildShapeRows,
  cycleShapesArtifact,
  historyArtifact,
} from "./artifacts";

// Cross-artifact consistency: cycle_params.json, cycle_shapes.json and
// history_daily.json are three hand-refreshed committed artifacts that must
// describe the SAME fit. A partial quarterly refresh (params regenerated
// without figures, or vice versa) is the failure mode these tests exist to
// catch — analysis/refresh_all.py regenerates them together, and this suite
// fails the build if they ever diverge.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("cross-artifact consistency (partial-refresh guard)", () => {
  it("cycle_shapes.json describes exactly the cycles the committed fit used", () => {
    expect(cycleShapesArtifact.cycles).toHaveLength(
      cycleParams.source.n_cycles_used,
    );
    expect(cycleShapesArtifact.source.n_cycles).toBe(
      cycleParams.source.n_cycles_used,
    );
  });

  it("cycle_shapes.json is pinned to the committed fit's exact span", () => {
    expect(cycleShapesArtifact.source.fit_span_start).toBe(
      cycleParams.source.span_start,
    );
    expect(cycleShapesArtifact.source.fit_span_end).toBe(
      cycleParams.source.span_end,
    );
  });

  it("cycle_shapes.json shares cycle_params.json's exact phase grid", () => {
    // Identical grid — not just same length — so the overlay's faint rows and
    // the bold template line need zero interpolation between them.
    expect(cycleShapesArtifact.phase).toEqual(cycleParams.shape.phase);
  });

  it("every fitted cycle falls inside the fit span and respects the exclusion rule", () => {
    for (const c of cycleShapesArtifact.cycles) {
      expect(c.start >= cycleParams.source.span_start).toBe(true);
      expect(c.end <= cycleParams.source.span_end).toBe(true);
      // Mirror of MAX_PERIOD_DAYS in analysis/cycle_fit.py — a longer cycle
      // here means the shapes were built without the shared select_cycles().
      expect(c.period_days).toBeLessThanOrEqual(55);
      expect(c.shape).toHaveLength(cycleShapesArtifact.phase.length);
    }
  });

  it("history_daily.json covers the committed fit's span and records it", () => {
    expect(historyArtifact.source.span_start <= cycleParams.source.span_start).toBe(true);
    expect(historyArtifact.source.span_end >= cycleParams.source.span_end).toBe(true);
    expect(historyArtifact.source.fit_span_end).toBe(cycleParams.source.span_end);
  });

  it("the anomaly window shaded on the chart is inside the charted history", () => {
    expect(anomalyWindow).not.toBeNull();
    if (anomalyWindow) {
      expect(anomalyWindow.start >= historyArtifact.source.span_start).toBe(true);
      expect(anomalyWindow.end <= historyArtifact.source.span_end).toBe(true);
    }
  });
});

describe("artifact schemas and value sanity", () => {
  it("both artifacts carry source blocks with the CC BY attribution", () => {
    for (const src of [historyArtifact.source, cycleShapesArtifact.source]) {
      expect(src.dataset).toContain("CC BY");
      expect(src.dataset).toContain("data.qld.gov.au");
      expect(src.fuel).toContain("U91");
    }
  });

  it("history days are ISO-dated, strictly ascending, and plausible prices", () => {
    let prev = "";
    for (const { d, p } of historyArtifact.days) {
      expect(d).toMatch(ISO_DATE);
      expect(d > prev).toBe(true);
      prev = d;
      // $/L bounds wide enough for real swings (incl. the 2026 anomaly peak
      // of $2.59) but tight enough to catch cents-vs-dollars unit slips.
      expect(p).toBeGreaterThan(1);
      expect(p).toBeLessThan(4);
    }
    expect(historyArtifact.days[0].d).toBe(historyArtifact.source.span_start);
    expect(historyArtifact.days.at(-1)?.d).toBe(historyArtifact.source.span_end);
  });

  it("shape values are normalised (0..1 with tolerance) on a 0..1 phase grid", () => {
    const { phase } = cycleShapesArtifact;
    expect(phase[0]).toBe(0);
    expect(phase.at(-1)).toBe(1);
    for (const c of cycleShapesArtifact.cycles) {
      for (const v of c.shape) {
        expect(v).toBeGreaterThanOrEqual(-0.001);
        expect(v).toBeLessThanOrEqual(1.001);
      }
    }
  });

  it("buildShapeRows keys every cycle plus the canonical from cycle_params.json", () => {
    const { rows, cycleKeys } = buildShapeRows();
    expect(rows).toHaveLength(cycleShapesArtifact.phase.length);
    expect(cycleKeys).toHaveLength(cycleParams.source.n_cycles_used);
    const first = rows[0];
    expect(first.canonical).toBe(cycleParams.shape.normalised_price[0]);
    for (const key of cycleKeys) {
      expect(typeof first[key]).toBe("number");
    }
  });
});
