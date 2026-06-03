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
// ---------------------------------------------------------------------------

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
    name: "Queensland Fuel Prices April 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/3584e9ca-0d92-4187-9f93-b60c41cb0c94/download/fuel-prices-2026-04-changes-only.csv",
  },
  // March + May 2026 are now published upstream (see issue #47). They land
  // here in the data-refresh PR (#47 PR-2), once the live-API seam strategy
  // is in place — the May CSV needs clipping at liveStartDay to avoid
  // double-counting against the live-API rows it overlaps.
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
  const prices = dedupeBy(
    rows.map(transformPrice),
    (p) => `${p.site_id}|${p.fuel_name}|${p.transaction_date_utc}`,
  );

  console.log(
    `  ${sites.length.toLocaleString()} unique sites, ${prices.length.toLocaleString()} unique price events`,
  );

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

async function main() {
  const client = createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  for (const resource of RESOURCES) {
    await importResource(client, resource);
  }

  console.log("\nAll resources imported.");
}

main().catch((err) => {
  console.error("\nBackfill failed:", err.message);
  process.exit(1);
});
