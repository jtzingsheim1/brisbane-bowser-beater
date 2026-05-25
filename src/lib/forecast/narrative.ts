import type { CycleParams, ProjectionResult } from "./types";

// Builds the daily narrative line shown under the chart, from the forecast.
//
// Language discipline (CLAUDE.md "Legal hygiene"): observation-only. We describe
// where prices ARE and where the forecast has them GOING — never why retailers
// price as they do, never blame, never guarantees. Everything is framed as an
// estimate ("~", "around", "typically"). Confident and useful, light, not preachy.

const PHASE_EDGE = 0.08; // how close to a turning point counts as "near" it

function fmtDate(isoDay: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Australia/Brisbane",
  }).format(new Date(`${isoDay}T00:00:00Z`));
}

function fmtPrice(dollars: number): string {
  return `$${dollars.toFixed(2)}/L`;
}

/**
 * Compose a one-or-two-sentence Brisbane U91 narrative from the projection and
 * the latest observed price. Returns observation-only copy suitable for the
 * public surface and the daily_narrative cache.
 */
export function buildNarrative(
  params: CycleParams,
  result: ProjectionResult,
  latestObservedPrice: number,
): string {
  const peakPhase = params.params.peak_phase;
  const ph = result.phaseAtAnchor;
  const now = fmtPrice(latestObservedPrice);

  const priceOn = (isoDay: string | null): string | null => {
    if (!isoDay) return null;
    const row = result.rows.find((r) => r.day === isoDay);
    return row ? fmtPrice(row.predictedPrice) : null;
  };

  const troughDay = result.nextTroughDay ? fmtDate(result.nextTroughDay) : null;
  const peakDay = result.nextPeakDay ? fmtDate(result.nextPeakDay) : null;
  const troughPrice = priceOn(result.nextTroughDay);
  const peakPrice = priceOn(result.nextPeakDay);

  const nearTrough = ph >= 1 - PHASE_EDGE || ph <= PHASE_EDGE;
  const nearPeak = Math.abs(ph - peakPhase) <= PHASE_EDGE;
  const climbing = ph > PHASE_EDGE && ph < peakPhase - PHASE_EDGE;

  if (nearTrough) {
    const climb =
      peakDay && peakPrice
        ? ` Prices usually climb from here — the forecast has the next peak around ${peakDay} (~${peakPrice}).`
        : " Prices usually climb from here.";
    return `Brisbane U91 is near the bottom of its cycle (~${now}) — about as good as it tends to get.${climb} A sensible time to fill.`;
  }

  if (climbing) {
    const peak =
      peakDay && peakPrice
        ? `peaking around ${peakDay} (~${peakPrice})`
        : "still climbing";
    return `Brisbane U91 is on the way up (~${now}), with the forecast ${peak}. If you're running low, sooner tends to beat later.`;
  }

  if (nearPeak) {
    const ease =
      troughDay && troughPrice
        ? ` It typically eases from here toward a trough around ${troughDay} (~${troughPrice})`
        : " It typically eases from here";
    return `Brisbane U91 is near the top of its cycle (~${now}).${ease} — worth waiting if you can.`;
  }

  // Easing phase (past the peak, heading down).
  const trough =
    troughDay && troughPrice
      ? `, with the next trough forecast around ${troughDay} (~${troughPrice})`
      : "";
  return `Brisbane U91 is easing down off its recent peak (~${now})${trough}. If you can hold off topping up, waiting should pay off.`;
}
