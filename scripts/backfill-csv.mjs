// One-shot importer for QLD open-data fuel-price CSVs (CC BY 4.0).
//
// Downloads each resource listed in RESOURCES, parses the rows, derives the
// unique set of sites + price-change events, and upserts both into Supabase
// (via the service_role key — bypasses RLS).
//
// Run:   npm run backfill:csv
// Re-run: safe. PK conflicts upsert rather than duplicate.

import { createClient } from "@supabase/supabase-js";
import {
  dedupeBy,
  parseRows,
  transformPrice,
  transformSite,
} from "./lib/csv-backfill.mjs";

// ---------------------------------------------------------------------------
// Resources to ingest. New monthly CSVs appear at data.qld.gov.au as the
// year progresses — extend this list when they're published.
//
// Optional per-resource fields:
//   clipBeforeDay: "YYYY-MM-DD"
//     Drop price events with transaction_date_utc >= clipBeforeDay. Used for
//     the May 2026 CSV (issue #47 PR-2): CSV owns days before liveStartDay,
//     the live API owns days from liveStartDay onward — the PK does NOT
//     deduplicate across sources because CSV timestamps are minute-precision
//     while live timestamps are millisecond-precision, so the same change
//     event from both sources lands as two rows. Clipping at liveStartDay
//     guarantees no overlap region exists by construction.
// ---------------------------------------------------------------------------

// First day live-API has ≥80% core-Brisbane (QLD postcode 4000-4179) site
// coverage, as measured by scripts/probe-live-coverage.mjs on 2026-06-03 (issue
// #47 PR-2). Coverage jumped from 49% on 2026-05-23 to 85% on 2026-05-24, a
// clean one-day cutover. Mirrors the LIVE_COVERAGE_THRESHOLD heuristic in
// src/lib/aggregates.ts. Hard-coded rather than recomputed at import time so
// reruns are deterministic — re-probe and update when the next refresh runs.
const LIVE_START_DAY = "2026-05-24";

const RESOURCES = [
  {
    name: "Queensland Fuel Prices January 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/61a27cfa-9ec5-47cc-8ce5-274f2dcb1908/download/fuel-prices-2026-01-changes-only.csv",
  },
  {
    name: "Queensland Fuel Prices February 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/f013457b-fd77-4cf0-91e7-28ef983d8c3c/download/fuel-prices-2026-02-changes-only.csv",
  },
  {
    name: "Queensland Fuel Prices March 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/b4369776-476e-444a-b8a7-e354e18e48b0/download/fuel-prices-2026-03-changes-only.csv",
  },
  {
    name: "Queensland Fuel Prices April 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/3584e9ca-0d92-4187-9f93-b60c41cb0c94/download/fuel-prices-2026-04-changes-only.csv",
  },
  {
    name: "Queensland Fuel Prices May 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/e4a5b659-441a-4d05-bb66-e7405ca22ae0/download/fuel-prices-2026-05-changes-only.csv",
    clipBeforeDay: LIVE_START_DAY,
  },
];

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Env + HTTP
// ---------------------------------------------------------------------------

function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function downloadCsv(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return await res.text();
}

// ---------------------------------------------------------------------------
// Supabase upserts
// ---------------------------------------------------------------------------

async function batchUpsert(client, table, rows, conflictTarget) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await client.from(table).upsert(batch, {
      onConflict: conflictTarget,
      ignoreDuplicates: false,
    });
    if (error) {
      console.error(
        `  ✗ Upsert into ${table} (rows ${i}..${i + batch.length}) failed: ${error.message}`,
      );
      throw error;
    }
  }
}

async function importResource(client, resource) {
  console.log(`\n→ ${resource.name}`);
  console.log(`  downloading…`);
  const csv = await downloadCsv(resource.url);
  console.log(`  downloaded ${(csv.length / 1024 / 1024).toFixed(1)} MB`);

  const rows = parseRows(csv);
  console.log(`  ${rows.length.toLocaleString()} CSV rows`);

  const sites = dedupeBy(rows.map(transformSite), (s) => s.site_id);
  const allPrices = dedupeBy(
    rows.map(transformPrice),
    (p) => `${p.site_id}|${p.fuel_name}|${p.transaction_date_utc}`,
  );

  // Optional clipping: drop events on or after clipBeforeDay. Used to hand
  // ownership of a date range to the live API (see RESOURCES comment + #47
  // PR-2). Compare on the date part of the ISO timestamp to avoid TZ skew.
  const prices = resource.clipBeforeDay
    ? allPrices.filter(
        (p) => p.transaction_date_utc.slice(0, 10) < resource.clipBeforeDay,
      )
    : allPrices;

  if (resource.clipBeforeDay) {
    const dropped = allPrices.length - prices.length;
    console.log(
      `  ${sites.length.toLocaleString()} unique sites, ${prices.length.toLocaleString()} unique price events ` +
        `(${dropped.toLocaleString()} dropped by clipBeforeDay=${resource.clipBeforeDay})`,
    );
  } else {
    console.log(
      `  ${sites.length.toLocaleString()} unique sites, ${prices.length.toLocaleString()} unique price events`,
    );
  }

  console.log(`  upserting sites…`);
  await batchUpsert(client, "sites", sites, "site_id");

  console.log(`  upserting price_snapshots…`);
  await batchUpsert(
    client,
    "price_snapshots",
    prices,
    "site_id,fuel_name,transaction_date_utc",
  );

  console.log(`  ✓ done`);
}

// ---------------------------------------------------------------------------

// One-shot deletion of live_api ramp-up rows (< LIVE_START_DAY for U91). The
// ramp-up days are below the LIVE_COVERAGE_THRESHOLD heuristic — their average
// is dominated by the few stations that had already started reporting — so we
// let the May CSV own those days instead. Gated by --cutover to keep ordinary
// re-runs of the backfill safe (idempotent, no destructive surprises).
async function runCutoverDelete(client) {
  console.log(`\n→ Cutover delete: live_api U91 rows < ${LIVE_START_DAY}`);
  const { error, count } = await client
    .from("price_snapshots")
    .delete({ count: "exact" })
    .eq("fuel_name", "Unleaded")
    .eq("data_source", "live_api")
    .lt("transaction_date_utc", `${LIVE_START_DAY}T00:00:00Z`);
  if (error) {
    console.error(`  ✗ Delete failed: ${error.message}`);
    throw error;
  }
  console.log(`  ✓ Deleted ${count?.toLocaleString() ?? "?"} rows`);
}

async function main() {
  const client = createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const cutover = process.argv.includes("--cutover");
  if (cutover) {
    await runCutoverDelete(client);
  }

  for (const resource of RESOURCES) {
    await importResource(client, resource);
  }

  console.log("\nAll resources imported.");
}

main().catch((err) => {
  console.error("\nBackfill failed:", err.message);
  process.exit(1);
});
