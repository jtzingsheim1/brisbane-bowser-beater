// The two committed history artifacts emitted by analysis/figures.py, plus
// row-shaping for the education charts. Like cycle_params.json, these JSONs
// are Python↔TS contracts: schema documented in analysis/figures.py, validated
// lightly here, and cross-checked against cycle_params.json in
// artifacts.test.ts (that test is what catches a partial quarterly refresh).
//
// Deliberately NOT server-only: the education charts are client components and
// the data is static public history — bundling it is the point (zero runtime
// data dependency, no staleness-gate coupling).

import cycleParams from "../../../analysis/output/cycle_params.json";
import shapesRaw from "../../../analysis/output/cycle_shapes.json";
import historyRaw from "../../../analysis/output/history_daily.json";

const SUPPORTED_SCHEMA_VERSION = 1;

export type HistoryDay = { d: string; p: number };

export type HistoryArtifact = {
  schema_version: number;
  generated_at: string;
  source: {
    dataset: string;
    region: string;
    fuel: string;
    span_start: string;
    span_end: string;
    fit_span_end: string;
  };
  days: HistoryDay[];
};

export type CycleShapesArtifact = {
  schema_version: number;
  generated_at: string;
  source: {
    dataset: string;
    region: string;
    fuel: string;
    fit_span_start: string;
    fit_span_end: string;
    n_cycles: number;
    exclusion: string;
  };
  phase: number[];
  cycles: Array<{
    start: string;
    end: string;
    period_days: number;
    shape: number[];
  }>;
};

function validateHistory(h: HistoryArtifact): HistoryArtifact {
  if (h.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `history_daily.json schema_version ${h.schema_version} unsupported`,
    );
  }
  if (h.days.length < 2) {
    throw new Error("history_daily.json has no usable series");
  }
  return h;
}

function validateShapes(s: CycleShapesArtifact): CycleShapesArtifact {
  if (s.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `cycle_shapes.json schema_version ${s.schema_version} unsupported`,
    );
  }
  if (s.cycles.length === 0 || s.phase.length < 2) {
    throw new Error("cycle_shapes.json has no usable cycles");
  }
  return s;
}

export const historyArtifact = validateHistory(historyRaw as HistoryArtifact);
export const cycleShapesArtifact = validateShapes(
  shapesRaw as CycleShapesArtifact,
);

// The anomaly window shaded on the history chart — read from cycle_params.json
// (the hand-authored observation-only record), not re-declared here.
export const anomalyWindow: { start: string; end: string } | null =
  cycleParams.anomaly_notes?.window ?? null;

export type ShapeRow = Record<string, number>;

// One combined row set for the overlay chart: the faint per-cycle series
// (keys c0..cN) and the bold canonical template — read STRAIGHT from
// cycle_params.json, never recomputed — share the identical phase grid, so no
// interpolation happens anywhere between Python and pixels.
export function buildShapeRows(): {
  rows: ShapeRow[];
  cycleKeys: string[];
} {
  const { phase, cycles } = cycleShapesArtifact;
  const canonical = cycleParams.shape.normalised_price;
  if (canonical.length !== phase.length) {
    throw new Error(
      "cycle_shapes.json phase grid does not match cycle_params.json shape",
    );
  }
  const cycleKeys = cycles.map((_, i) => `c${i}`);
  const rows = phase.map((ph, i) => {
    const row: ShapeRow = { phase: ph, canonical: canonical[i] };
    cycles.forEach((c, j) => {
      row[cycleKeys[j]] = c.shape[i];
    });
    return row;
  });
  return { rows, cycleKeys };
}
