// One-shot diagnostic: compute liveStartDay (first day live-API has ≥80% core
// Brisbane site coverage) and print a daily-coverage table for inclusion in
// docs/data-refresh-2026-05.md. Mirrors the logic in src/lib/aggregates.ts
// liveCoverageRampEnd() but reports more context. Read-only.
//
// Run: node --env-file=.env.local scripts/probe-live-coverage.mjs

import { createClient } from "@supabase/supabase-js";

const LIVE_COVERAGE_THRESHOLD = 0.8;
const FUEL_NAME = "Unleaded";

function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function main() {
  const client = createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const { count: coreCount, error: coreErr } = await client
    .from("sites")
    .select("*", { count: "exact", head: true })
    .eq("state", "QLD")
    .gte("postcode", "4000")
    .lte("postcode", "4179");
  if (coreErr) throw coreErr;
  console.log(`core Brisbane sites (QLD postcode 4000-4179): ${coreCount}`);
  const needed = Math.ceil(coreCount * LIVE_COVERAGE_THRESHOLD);
  console.log(`80% threshold: ${needed} sites`);

  // Pull every live_api row for U91 ordered ascending. (Pagination — Supabase
  // caps a single response at 1000 rows.)
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("price_snapshots")
      .select("site_id, transaction_date_utc")
      .eq("fuel_name", FUEL_NAME)
      .eq("data_source", "live_api")
      .order("transaction_date_utc", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`live_api U91 rows: ${all.length.toLocaleString()}`);

  // Daily coverage: cumulative-distinct-sites-by-day. Once a site has reported,
  // it counts toward every later day's coverage (mirrors liveCoverageRampEnd's
  // running Set semantics).
  const seenCumulative = new Set();
  const cumByDay = new Map(); // day -> cumulative-distinct sites at end of day
  for (const row of all) {
    const day = isoDay(row.transaction_date_utc);
    seenCumulative.add(row.site_id);
    cumByDay.set(day, seenCumulative.size);
  }
  // Forward-fill days where no events landed at all.
  const days = [...cumByDay.keys()].sort();
  let runningMax = 0;
  const series = [];
  if (days.length > 0) {
    const start = new Date(`${days[0]}T00:00:00Z`);
    const end = new Date(`${days[days.length - 1]}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = isoDay(d);
      runningMax = Math.max(runningMax, cumByDay.get(k) ?? 0);
      series.push({ day: k, cum: runningMax });
    }
  }

  console.log(
    "\nday          cum.sites  pct  crossed-threshold?",
  );
  let firstAdequateDay = null;
  for (const row of series) {
    const pct = ((row.cum / coreCount) * 100).toFixed(1);
    const crossed = row.cum >= needed;
    if (crossed && !firstAdequateDay) firstAdequateDay = row.day;
    console.log(
      `${row.day}   ${String(row.cum).padStart(4)}      ${pct.padStart(5)}%  ${crossed ? "yes" : ""}`,
    );
  }

  console.log("");
  if (firstAdequateDay) {
    const fd = new Date(`${firstAdequateDay}T00:00:00Z`);
    fd.setUTCDate(fd.getUTCDate() - 1);
    const rampEnd = isoDay(fd);
    console.log(`first day live coverage >=80%: ${firstAdequateDay}`);
    console.log(`liveCoverageRampEnd():         ${rampEnd}`);
    console.log(`liveStartDay (cutover anchor): ${firstAdequateDay}`);
  } else {
    console.log("coverage never reached 80% — no liveStartDay yet");
  }
}

main().catch((err) => {
  console.error("probe failed:", err.message);
  process.exit(1);
});
