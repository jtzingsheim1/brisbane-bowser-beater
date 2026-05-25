// Daily Brisbane U91 forecast + narrative generation.
//
// Reuses the production projection (src/lib/forecast) so there is a single
// source of truth shared with the Vercel route — this script just feeds it the
// live Supabase aggregate (no Next.js layer) and writes a fresh batch into
// `forecasts`, plus the matching daily narrative line into `daily_narrative`.
// Runs once a day under GitHub Actions, after the price ingest.
// Pre-deploy this is the only forecast generator; the Vercel route shares the
// same lib, so they can't drift.
//
// Run locally:
//   node --env-file=.env.local --import tsx scripts/generate-forecast.ts        (writes)
//   node --env-file=.env.local --import tsx scripts/generate-forecast.ts --dry  (prints only)

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNarrative } from "../src/lib/forecast/narrative";
import { getCycleParams } from "../src/lib/forecast/params";
import {
  projectForecast,
  type ObservedPoint,
} from "../src/lib/forecast/project";
import { readEnv, supabaseAdmin } from "./lib/qld-api.mjs";

const HISTORY_DAYS = 90;
const FUEL_NAME = "Unleaded";
const REGION = "brisbane_metro";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Mirrors src/lib/aggregates.ts getBrisbaneDailyU91History, minus the Next
// cache layer: anchor the window to the most-recent observed event (not now())
// so a quiet period doesn't shorten the history we fit against.
async function loadHistory(client: SupabaseClient): Promise<ObservedPoint[]> {
  const { data: latest, error: latestErr } = await client
    .from("price_snapshots")
    .select("transaction_date_utc")
    .eq("fuel_name", FUEL_NAME)
    .order("transaction_date_utc", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw latestErr;

  const end = latest?.transaction_date_utc
    ? new Date(latest.transaction_date_utc)
    : new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - HISTORY_DAYS);

  const { data, error } = await client.rpc("brisbane_daily_avg_u91", {
    start_date: isoDate(start),
    end_date: isoDate(end),
  });
  if (error) throw error;
  return (data ?? []).map((r: { day: string; avg_price: number }) => ({
    day: r.day,
    avgPrice: Number(r.avg_price),
  }));
}

async function main() {
  readEnv("SUPABASE_SERVICE_ROLE_KEY"); // fail fast before any work
  const dry = process.argv.includes("--dry");
  const client = supabaseAdmin();

  const params = getCycleParams();
  const history = await loadHistory(client);
  const result = projectForecast(params, history);

  if (!result) {
    // Expected during the backfill→live gap: not enough varying history after
    // dead-zone trimming. The daily live feed fills this in; exit clean.
    console.log(
      `No forecast written: only ${history.length} daily points and too little ` +
        `varying data after dead-zone trimming. The live feed will accumulate it.`,
    );
    return;
  }

  console.log(
    `anchor ${result.anchorDay} | phase ${result.phaseAtAnchor} | ` +
      `trough $${result.troughLevel} | swing $${result.swing}` +
      (result.amplitudeClamped ? " (swing clamped)" : ""),
  );
  console.log(
    `next trough: ${result.nextTroughDay ?? "—"} | ` +
      `next peak: ${result.nextPeakDay ?? "—"} | ${result.rows.length} rows`,
  );

  const latestObserved =
    history[history.length - 1]?.avgPrice ?? result.rows[0].predictedPrice;
  const narrative = buildNarrative(params, result, latestObserved);
  console.log(`narrative: ${narrative}`);

  if (dry) {
    console.log("\n--dry: not writing. Every 5th projected day:");
    result.rows.forEach((r, i) => {
      if (i % 5 === 0) {
        console.log(
          `  ${r.day}  $${r.predictedPrice.toFixed(3)}  ` +
            `[${r.bandLow.toFixed(3)}, ${r.bandHigh.toFixed(3)}]`,
        );
      }
    });
    return;
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

  const { error } = await client.from("forecasts").insert(rows);
  if (error) throw error;
  console.log(`✓ Inserted ${rows.length} forecast rows (generated_at ${generatedAt})`);

  const { error: narrativeErr } = await client.from("daily_narrative").upsert(
    {
      narrative_date: result.anchorDay,
      fuel_name: FUEL_NAME,
      region: REGION,
      narrative_text: narrative,
      generated_at: generatedAt,
    },
    { onConflict: "narrative_date,fuel_name,region" },
  );
  if (narrativeErr) throw narrativeErr;
  console.log(`✓ Upserted daily_narrative for ${result.anchorDay}`);
}

main().catch((err) => {
  console.error("\nForecast generation failed:", err.message);
  process.exit(1);
});
