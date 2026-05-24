// TypeScript mirror of the cycle characterisation contract produced by the
// offline Python pipeline (analysis/build_params.py -> output/cycle_params.json).
// The schema is documented inline in build_params.py; keep these in sync.
//
// All prices are in $/L, matching price_snapshots.price (the CSV's tenths-of-
// cents are divided by 1000 at ingestion, so the DB and this template share a
// unit). The canonical shape is min-max normalised (0 = trough, 1 = peak) on a
// phase axis (0 = trough -> 1 = next trough).

export type CycleParams = {
  schema_version: number;
  generated_at: string;
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
  shape: {
    phase: number[]; // ascending 0..1, uniform
    normalised_price: number[]; // canonical shape, same length as phase
    band_std: number[]; // per-phase std across cycles, same length
  };
  drift_notes: string;
};

// A single projected day, in the shape the forecasts table + chart expect.
export type ForecastRow = {
  day: string; // ISO date (YYYY-MM-DD)
  predictedPrice: number; // $/L
  bandLow: number; // $/L, clamped >= 0
  bandHigh: number; // $/L
};

export type ProjectionResult = {
  anchorDay: string; // last observed day; projection starts here
  phaseAtAnchor: number; // 0..1, detected cycle position at the anchor
  troughLevel: number; // fitted local trough price ($/L)
  swing: number; // fitted local trough->peak swing ($/L)
  amplitudeClamped: boolean; // true if the fit was guarded to the characterised range
  nextTroughDay: string | null; // next phase-0 date within the horizon, if any
  nextPeakDay: string | null; // next peak-phase date within the horizon, if any
  rows: ForecastRow[];
};
