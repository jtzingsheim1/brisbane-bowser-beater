// The static tool payload: BBB's committed cycle characterisation, curated
// from analysis/output/cycle_params.json (the Python->TS contract artifact).
// esbuild inlines the JSON at build time, so this tool involves no I/O at
// all. Field meanings are documented in analysis/build_params.py and mirrored
// in src/lib/forecast/types.ts in the main app.

import cycleParams from "../../analysis/output/cycle_params.json" with { type: "json" };

export type CycleModel = {
  source: {
    dataset: string;
    region: string;
    fuel: string;
    span_start: string;
    span_end: string;
    n_cycles_used: number;
    n_cycles_excluded: number;
  };
  method: {
    detrend: string;
    detection: string;
    weighting: string;
    exclusion: string;
  };
  params: {
    period_days: number;
    amplitude_dollars: number;
    asymmetry: number;
    peak_phase: number;
  };
  uncertainty: {
    period_days_std: number;
    amplitude_dollars_std: number;
  };
  drift_notes: string;
  anomaly_notes: {
    window: { start: string; end: string };
    summary: string;
  };
  shape?: {
    phase: number[];
    normalised_price: number[];
    band_std: number[];
  };
};

export function getCycleModel(includeShape: boolean): CycleModel {
  const p = cycleParams;
  return {
    source: p.source,
    method: p.method,
    params: p.params,
    uncertainty: p.uncertainty,
    drift_notes: p.drift_notes,
    // The full anomaly_notes block includes internal modelling rationale;
    // the window and summary are the parts useful to a data consumer.
    anomaly_notes: {
      window: p.anomaly_notes.window,
      summary: p.anomaly_notes.summary,
    },
    ...(includeShape ? { shape: p.shape } : {}),
  };
}
