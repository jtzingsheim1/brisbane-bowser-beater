// One-shot importer for QLD open-data fuel-price CSVs (CC BY 4.0).
//
// Downloads each resource listed in RESOURCES, parses the rows, derives the
// unique set of sites + price-change events, and upserts both into Supabase
// (via the service_role key — bypasses RLS).
//
// Run:   npm run backfill:csv
// Re-run: safe. PK conflicts upsert rather than duplicate.

import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

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
  // March 2026 was not published by QLD as of 2026-05-27 (April landed first).
  // April is loaded for chart display only; the cycle model deliberately does
  // NOT fit across the March hole (see PLAN.md). When March backfills, add it
  // here and the deadzone gap closes automatically.
  {
    name: "Queensland Fuel Prices April 2026",
    url: "https://www.data.qld.gov.au/dataset/0dfad294-f852-45a5-b86f-986773745fe2/resource/3584e9ca-0d92-4187-9f93-b60c41cb0c94/download/fuel-prices-2026-04-changes-only.csv",
  },
];

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Env + small helpers
// ---------------------------------------------------------------------------

function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// "4/01/2026 20:42" → "2026-01-04T20:42:00Z"
function parseDateUtc(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Unrecognised date format: "${s}"`);
  const [, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00Z`;
}

// "1860" → 1.860 (CSV stores price in tenths-of-cents)
function parsePrice(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Bad price: "${s}"`);
  return n / 1000;
}

function toNumberOrNull(s) {
  if (s === "" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function dedupeBy(rows, keyFn) {
  const seen = new Map();
  for (const r of rows) seen.set(keyFn(r), r); // last wins
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// CSV → row objects
// ---------------------------------------------------------------------------

async function downloadCsv(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return await res.text();
}

function parseRows(csvText) {
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
}

function transformSite(row) {
  return {
    site_id: Number(row.SiteId),
    name: row.Site_Name,
    address: row.Sites_Address_Line_1,
    postcode: row.Site_Post_Code || null,
    suburb: row.Site_Suburb || null,
    state: row.Site_State || null,
    lat: toNumberOrNull(row.Site_Latitude),
    lng: toNumberOrNull(row.Site_Longitude),
    brand_name: row.Site_Brand || null,
    // brand_id, g1..g5, hours, last_modified_at stay NULL until the live API populates them
  };
}

function transformPrice(row) {
  return {
    site_id: Number(row.SiteId),
    fuel_name: row.Fuel_Type,
    price: parsePrice(row.Price),
    transaction_date_utc: parseDateUtc(row.TransactionDateutc),
    data_source: "csv_backfill",
    collection_method: null,
  };
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
