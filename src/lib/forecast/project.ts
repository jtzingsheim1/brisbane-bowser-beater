import type { CycleParams, ForecastRow, ProjectionResult } from "./types";

// How far ahead to project. CLAUDE.md: "~30 days forecast".
const HORIZON_DAYS = 30;
// Phase-search resolution. period ~39d / 360 ≈ 0.1 day per step — plenty fine.
const PHASE_GRID = 360;
// Band width in standard deviations of the per-phase inter-cycle spread.
// README framing: "the range past cycles have moved within". 1σ is honest and
// readable without implying a guaranteed envelope.
const BAND_Z = 1;
// Sanity bounds on the fitted swing, as multiples of the characterised
// amplitude. Wide enough to admit a genuinely large current cycle (recent
// Brisbane cycles have swung well above the 3-year mean) but tight enough to
// catch a degenerate fit. This is a backstop, not a target.
const MIN_SWING_FACTOR = 0.5;
const MAX_SWING_FACTOR = 2.0;
// Trailing observed points whose median pins the anchor level, so the forecast
// line springs from where prices actually are (clean join on the chart) rather
// than the SSE-optimal level, which can sit well off the most recent price.
const LEVEL_PIN_POINTS = 3;
// How much recent history to fit against. Just over one cycle: enough to lock
// the phase, but short enough that the single (trough, swing) pair represents
// the *current* cycle rather than averaging across cycles whose baseline levels
// have drifted (which would inflate the fitted swing). This matches the Python
// pipeline's amplitude definition — a single cycle's raw peak-to-trough.
const FIT_WINDOW_DAYS = 45;
// Carry-forward dead-zone handling. When ingestion stalls — or before the live
// feed has filled in history (the gap between the CSV backfill and go-live) —
// the daily series goes perfectly flat: each station's last-known price carried
// forward unchanged. Fitting the cycle against a flat stretch is meaningless,
// so we trim it and fit only against the most-recent contiguous run of
// genuinely-varying data. A run of DEADZONE_RUN_DAYS daily averages identical
// within FLAT_EPS marks a dead zone; we need at least MIN_FIT_POINTS real days
// after it to attempt a fit, else we decline to forecast (return null) rather
// than emit a confidently-wrong line.
const DEADZONE_RUN_DAYS = 7;
const FLAT_EPS = 0.001; // $/L — daily averages within 0.1c are "identical"
const MIN_FIT_POINTS = 7;

export type ObservedPoint = { day: string; avgPrice: number };

const MS_PER_DAY = 86_400_000;

function dayIndex(isoDay: string): number {
  return Math.round(Date.parse(`${isoDay}T00:00:00Z`) / MS_PER_DAY);
}

function isoFromIndex(index: number): string {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

function wrapPhase(phase: number): number {
  return ((phase % 1) + 1) % 1;
}

// Linear interpolation of `ys` (sampled at ascending, uniform `xs` in 0..1) at
// `x` in [0,1]. Clamps at the ends.
function interp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

type LinFit = { a: number; b: number; sse: number };

// Least-squares fit of v ≈ a + b·m. Returns null if degenerate.
function linearFit(v: number[], m: number[]): LinFit | null {
  const n = v.length;
  let sm = 0;
  let sv = 0;
  let smm = 0;
  let smv = 0;
  for (let i = 0; i < n; i++) {
    sm += m[i];
    sv += v[i];
    smm += m[i] * m[i];
    smv += m[i] * v[i];
  }
  const denom = n * smm - sm * sm;
  if (Math.abs(denom) < 1e-9) return null;
  const b = (n * smv - sm * sv) / denom;
  const a = (sv - b * sm) / n;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = v[i] - (a + b * m[i]);
    sse += r * r;
  }
  return { a, b, sse };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// Drop everything up to and including the last dead-zone (flat carry-forward)
// run, returning the most-recent contiguous stretch of varying data. `pts` must
// be ascending by day. If the series ends inside a dead zone, returns an empty
// array (the caller then declines to forecast).
function trimDeadZone(pts: ObservedPoint[]): ObservedPoint[] {
  let cutoff = 0;
  let runLen = 1;
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i].avgPrice - pts[i - 1].avgPrice) <= FLAT_EPS) {
      runLen++;
      if (runLen >= DEADZONE_RUN_DAYS) cutoff = i + 1;
    } else {
      runLen = 1;
    }
  }
  return pts.slice(cutoff);
}

/**
 * Project the Brisbane U91 daily average forward from observed history using
 * the characterised cycle template.
 *
 * Method (shape-agnostic — the asymmetric "rise fast, ease slow" behaviour
 * comes entirely from the template, not a hardcoded functional form):
 *
 *  1. Anchor by least-squares phase fit. Over the recent window, grid-search
 *     the phase at the anchor day. For each candidate, map every observed day
 *     to its template phase and fit observed ≈ trough + swing·template(phase).
 *     The lowest-error candidate recovers cycle position, local trough level,
 *     and local swing in one shot. The swing is then guarded to the
 *     characterised amplitude range.
 *  2. Project forward by advancing the phase 1/period per day.
 *  3. Bands: ±BAND_Z · swing · band_std(phase) from the characterised
 *     per-phase inter-cycle spread.
 *
 * Returns null if there isn't enough history to anchor against.
 */
export function projectForecast(
  params: CycleParams,
  history: ObservedPoint[],
): ProjectionResult | null {
  if (history.length < 14) return null;

  const period = params.params.period_days;
  const characterisedAmp = params.params.amplitude_dollars;
  const { phase, normalised_price, band_std } = params.shape;

  // Sort ascending and keep the most recent FIT_WINDOW_DAYS for anchoring.
  const sorted = [...history].sort((p, q) => (p.day < q.day ? -1 : 1));
  const anchorIdx = dayIndex(sorted[sorted.length - 1].day);
  const recentWindow = sorted.filter(
    (p) => anchorIdx - dayIndex(p.day) < FIT_WINDOW_DAYS,
  );

  // Fit only against the most-recent run of genuinely-varying data, so a flat
  // carry-forward dead zone in the window can't corrupt the phase/swing fit.
  const fitPts = trimDeadZone(recentWindow);
  if (fitPts.length < MIN_FIT_POINTS) return null;

  const offsets = fitPts.map((p) => anchorIdx - dayIndex(p.day)); // days before anchor
  const values = fitPts.map((p) => p.avgPrice);

  // Grid-search the phase at the anchor day.
  let best: { phi0: number; fit: LinFit } | null = null;
  for (let g = 0; g < PHASE_GRID; g++) {
    const phi0 = g / PHASE_GRID;
    const m = offsets.map((off) =>
      interp(phase, normalised_price, wrapPhase(phi0 - off / period)),
    );
    const fit = linearFit(values, m);
    if (!fit || fit.b <= 0) continue; // require positive correlation
    if (!best || fit.sse < best.fit.sse) best = { phi0, fit };
  }

  if (!best) return null;

  let { b } = best.fit;
  const phi0 = best.phi0;

  // Guard the swing to a sane range; this is a backstop against a degenerate
  // fit, not a target for normal cycles.
  const minB = MIN_SWING_FACTOR * characterisedAmp;
  const maxB = MAX_SWING_FACTOR * characterisedAmp;
  const amplitudeClamped = b < minB || b > maxB;
  b = Math.min(maxB, Math.max(minB, b));

  // Pin the trough level so the projection passes through the most recent
  // observed price at the anchor: a = recent - b·template(phaseAtAnchor). Uses
  // the trailing median to shrug off single-day noise. This guarantees the
  // forecast line joins the observed line cleanly.
  const tail = values.slice(-Math.min(LEVEL_PIN_POINTS, values.length));
  const recent = [...tail].sort((x, y) => x - y)[Math.floor(tail.length / 2)];
  const a = recent - b * interp(phase, normalised_price, phi0);

  // Project forward. Day offset 0 = anchor day, so the forecast line joins the
  // last observed point cleanly on the chart; 1..HORIZON_DAYS are future.
  const rows: ForecastRow[] = [];
  let nextTroughDay: string | null = null;
  let nextPeakDay: string | null = null;
  const peakPhase = params.params.peak_phase;

  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const ph = wrapPhase(phi0 + d / period);
    const norm = interp(phase, normalised_price, ph);
    const predicted = a + b * norm;
    const half = BAND_Z * b * interp(phase, band_std, ph);
    const isoDay = isoFromIndex(anchorIdx + d);
    rows.push({
      day: isoDay,
      predictedPrice: round3(predicted),
      bandLow: round3(Math.max(0, predicted - half)),
      bandHigh: round3(predicted + half),
    });

    // Flag the first future trough (phase wraps past 0) and peak crossing.
    if (d > 0) {
      const prevPh = wrapPhase(phi0 + (d - 1) / period);
      if (nextTroughDay === null && ph < prevPh) nextTroughDay = isoDay;
      if (
        nextPeakDay === null &&
        prevPh < peakPhase &&
        ph >= peakPhase &&
        ph >= prevPh
      ) {
        nextPeakDay = isoDay;
      }
    }
  }

  return {
    anchorDay: isoFromIndex(anchorIdx),
    phaseAtAnchor: round3(phi0),
    troughLevel: round3(a),
    swing: round3(b),
    amplitudeClamped,
    nextTroughDay,
    nextPeakDay,
    rows,
  };
}

export { HORIZON_DAYS };
