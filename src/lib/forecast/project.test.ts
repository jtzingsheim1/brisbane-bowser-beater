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

  // post_anomaly_anchor_date gate (#47 PR-3). The fitted cycles end 2026-02-28
  // and the anchor date is 2026-05-01 — anything before that is anomaly-window
  // contaminated and shouldn't reach the fit.
  describe("post-anomaly anchor gate", () => {
    const anchorDate = params.post_anomaly_anchor_date;

    it("returns null when the latest observed day is before the anchor date", () => {
      // 20 daily points ending well before anchorDate (2026-05-01).
      const hist = series(Array<number>(20).fill(0).map((_, i) => 1.8 + 0.01 * i), "2026-02-01");
      const lastDay = hist[hist.length - 1].day;
      expect(lastDay < anchorDate).toBe(true);
      expect(projectForecast(params, hist)).toBeNull();
    });

    it("returns null when post-anchor history is too short (<14 days)", () => {
      // 30 pre-anchor days + 5 post-anchor days = 35 total, but only 5 usable.
      const pre = series(Array<number>(30).fill(0).map((_, i) => 2.0 - 0.01 * i), "2026-04-01");
      const post = series([1.8, 1.85, 1.9, 1.88, 1.86], "2026-05-01");
      expect(projectForecast(params, [...pre, ...post])).toBeNull();
    });

    it("anchors on the post-anchor window, ignoring pre-anchor anomaly data", () => {
      // Pre-anchor: anomaly-style high prices ~$2.50 (shouldn't influence fit).
      const pre = series(
        Array<number>(40).fill(0).map((_, i) => 2.5 + 0.005 * (i % 7)),
        "2026-03-15",
      );
      // Post-anchor: realistic cycling around ~$1.80, long enough to anchor.
      const postPrices = [
        1.78, 1.76, 1.74, 1.72, 1.7, 1.73, 1.76, 1.79, 1.82, 1.85, 1.88, 1.91,
        1.94, 1.97, 2.0, 2.03, 1.99, 1.96,
      ];
      const post = series(postPrices, "2026-05-01");
      const result = projectForecast(params, [...pre, ...post]);
      expect(result).not.toBeNull();
      if (!result) return;
      // anchorDay is the latest observed day, which must be a post-anchor day.
      expect(result.anchorDay >= anchorDate).toBe(true);
      expect(result.anchorDay).toBe(post[post.length - 1].day);
      // First projected price joins post-anchor prices (~$2), nowhere near the
      // pre-anchor anomaly level (~$2.5). 0.20 is a generous tolerance.
      expect(Math.abs(result.rows[0].predictedPrice - 1.96)).toBeLessThan(0.2);
    });
  });

  it("projects HORIZON+1 rows that join the last observed price", () => {
    const prices = [
      2.08, 2.06, 2.04, 2.01, 1.99, 1.97, 1.95, 1.93, 1.92, 1.91, 1.9, 1.9,
      1.89, 1.9, 1.92, 1.95, 1.99, 2.02,
    ];
    // Start after post_anomaly_anchor_date so the gate doesn't filter the
    // synthetic series out (#47 PR-3).
    const hist = series(prices, "2026-05-02");
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
