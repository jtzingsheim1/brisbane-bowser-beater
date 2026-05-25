import { getBrisbaneDailyU91History } from "@/lib/aggregates";
import { getCycleParams } from "@/lib/forecast/params";
import { projectForecast, type ObservedPoint } from "@/lib/forecast/project";
import { supabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 30;
// Always run on request — never serve a statically cached forecast generation.
export const dynamic = "force-dynamic";

// The forecast grain (see migration 0007). MVP writes one fuel + one region.
const FUEL_NAME = "Unleaded";
const REGION = "brisbane_metro";
// Fetch a bit more than the projection's fit window so anchoring has headroom.
const HISTORY_DAYS = 90;

// Honour CRON_SECRET if it's configured (Phase 5). When unset (local dev) the
// endpoint is open — there's no secret to check against yet.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const history = await getBrisbaneDailyU91History(HISTORY_DAYS);
  const observed: ObservedPoint[] = history.map((h) => ({
    day: h.day,
    avgPrice: h.avgPrice,
  }));

  const result = projectForecast(getCycleParams(), observed);
  if (!result) {
    return Response.json(
      {
        ok: false,
        reason: "insufficient_history",
        observed_days: observed.length,
      },
      { status: 422 },
    );
  }

  // Dry run: return the projection without writing. Lets the cron path be
  // exercised (and the model inspected) without mutating the forecasts table.
  if (new URL(req.url).searchParams.get("dry") === "1") {
    return Response.json({
      ok: true,
      dry_run: true,
      observed_days: observed.length,
      anchor_day: result.anchorDay,
      phase_at_anchor: result.phaseAtAnchor,
      trough_level: result.troughLevel,
      swing: result.swing,
      amplitude_clamped: result.amplitudeClamped,
      next_trough_day: result.nextTroughDay,
      next_peak_day: result.nextPeakDay,
      rows: result.rows,
    });
  }

  const generatedAt = new Date().toISOString();
  const rows = result.rows.map((r) => ({
    forecast_for_date: r.day,
    fuel_name: FUEL_NAME,
    region: REGION,
    generated_at: generatedAt,
    predicted_price: r.predictedPrice,
    band_low: r.bandLow,
    band_high: r.bandHigh,
  }));

  const { error } = await supabaseAdmin().from("forecasts").insert(rows);
  if (error) {
    // Log details server-side; don't leak DB internals in the response body.
    console.error("[cron/forecast] write failed:", error.message);
    return Response.json(
      { ok: false, reason: "write_failed" },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    generated_at: generatedAt,
    anchor_day: result.anchorDay,
    phase_at_anchor: result.phaseAtAnchor,
    trough_level: result.troughLevel,
    swing: result.swing,
    amplitude_clamped: result.amplitudeClamped,
    next_trough_day: result.nextTroughDay,
    next_peak_day: result.nextPeakDay,
    rows_written: rows.length,
  });
}
