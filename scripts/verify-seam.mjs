// Post-import verification for issue #47 PR-2 seam cutover. Read-only.
//   1) PK-collision count across data_source for U91 — must be 0.
//   2) Brisbane core-Metro U91 daily mean for liveStartDay ± 3 days.
//
// Run: node --env-file=.env.local scripts/verify-seam.mjs

import { createClient } from "@supabase/supabase-js";

const LIVE_START_DAY = "2026-05-24";

function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const client = createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // (1) PK-collision count: for U91, count (site_id, transaction_date_utc) keys
  // that appear under more than one data_source. Pull pages and bucket in JS —
  // there's no `group by` in PostgREST.
  console.log("PK collision probe (U91, across data_source)...");
  const PAGE = 1000;
  const seen = new Map(); // key -> Set of data_source values
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("price_snapshots")
      .select("site_id, transaction_date_utc, data_source")
      .eq("fuel_name", "Unleaded")
      .order("site_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) {
      const k = `${r.site_id}|${r.transaction_date_utc}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(r.data_source);
    }
    total += data.length;
    if (data.length < PAGE) break;
  }
  console.log(`  scanned ${total.toLocaleString()} U91 rows`);
  let collisions = 0;
  for (const sources of seen.values()) {
    if (sources.size > 1) collisions++;
  }
  console.log(`  cross-source collision keys: ${collisions}`);

  // (2) Brisbane daily mean ±3 days around liveStartDay via the RPC the
  // production page uses.
  const start = addDays(LIVE_START_DAY, -3);
  const end = addDays(LIVE_START_DAY, 3);
  console.log(`\nDiscontinuity probe (Brisbane core-Metro U91 daily mean) ${start} → ${end}`);
  const { data, error } = await client.rpc("brisbane_daily_avg_u91", {
    start_date: start,
    end_date: end,
  });
  if (error) throw error;
  console.log("  day          avg_price  stations  day-over-day");
  let prev = null;
  for (const r of data ?? []) {
    const px = Number(r.avg_price);
    const dod = prev === null ? "—" : `${(px - prev >= 0 ? "+" : "") + (px - prev).toFixed(3)}`;
    console.log(
      `  ${r.day}   ${px.toFixed(3)}     ${String(r.station_count).padStart(4)}     ${dod}`,
    );
    prev = px;
  }
}

main().catch((err) => {
  console.error("verify-seam failed:", err.message);
  process.exit(1);
});
