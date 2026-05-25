import { describe, expect, it } from "vitest";
import { getCycleParams } from "./params";
import {
  projectForecast,
  stripTrailingFlat,
  trimDeadZone,
  type ObservedPoint,
} from "./project";

const MS_PER_DAY = 86_400_000;

// Build an ascending daily series from a list of prices.
function series(prices: number[], startDay = "2026-04-01"): ObservedPoint[] {
  const start = Date.parse(`${startDay}T00:00:00Z`);
  return prices.map((avgPrice, i) => ({
    day: new Date(start + i * MS_PER_DAY).toISOString().slice(0, 10),
    avgPrice,
  }));
}

describe("trimDeadZone", () => {
  it("drops a long leading flat run and returns the live tail", () => {
    const pts = series([
      ...Array<number>(10).fill(2.0), // 10-day dead zone
      1.9,
      1.85,
      1.8,
      1.84,
      1.9, // varying live tail
    ]);
    const out = trimDeadZone(pts);
    expect(out).toHaveLength(5);
    expect(out[0].avgPrice).toBe(1.9);
  });

  it("returns empty when the series ends inside a dead zone", () => {
    expect(trimDeadZone(series(Array<number>(12).fill(2.0)))).toHaveLength(0);
  });

  it("preserves a sub-threshold flat run (< 7 days)", () => {
    const pts = series([2.0, 2.0, 2.0, 1.9, 1.8, 1.85]); // 3-day flat
    expect(trimDeadZone(pts)).toHaveLength(6);
  });
});

describe("stripTrailingFlat", () => {
  it("collapses a trailing flat run down to the anchor", () => {
    const out = stripTrailingFlat(series([1.8, 1.85, 1.9, 1.91, 1.91, 1.91]));
    expect(out.map((p) => p.avgPrice)).toEqual([1.8, 1.85, 1.9, 1.91]);
  });

  it("leaves a window with no trailing flat unchanged", () => {
    expect(stripTrailingFlat(series([1.8, 1.85, 1.9, 1.95]))).toHaveLength(4);
  });
});

describe("projectForecast", () => {
  const params = getCycleParams();

  it("returns null with too little history", () => {
    expect(projectForecast(params, series([1.8, 1.85, 1.9]))).toBeNull();
  });

  it("returns null when the recent window is all dead-zone", () => {
    expect(projectForecast(params, series(Array<number>(40).fill(2.0)))).toBeNull();
  });

  it("projects HORIZON+1 rows that join the last observed price", () => {
    const prices = [
      2.08, 2.06, 2.04, 2.01, 1.99, 1.97, 1.95, 1.93, 1.92, 1.91, 1.9, 1.9,
      1.89, 1.9, 1.92, 1.95, 1.99, 2.02,
    ];
    const hist = series(prices);
    const r = projectForecast(params, hist);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.rows).toHaveLength(31); // HORIZON_DAYS + 1
    expect(r.anchorDay).toBe(hist[hist.length - 1].day);
    // row[0] anchors near the latest observed price (clean chart join)
    expect(Math.abs(r.rows[0].predictedPrice - prices[prices.length - 1])).toBeLessThan(0.08);
    expect(r.swing).toBeGreaterThan(0);
    // bands, when present, bracket the prediction
    for (const row of r.rows) {
      expect(row.bandLow).toBeLessThanOrEqual(row.predictedPrice);
      expect(row.bandHigh).toBeGreaterThanOrEqual(row.predictedPrice);
    }
  });
});
