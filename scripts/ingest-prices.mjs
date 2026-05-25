// Live 30-minute price ingest for Brisbane Metro U91.
//
// Pulls the current standing prices for the Brisbane L2 region, narrows to
// core-Brisbane U91, and upserts them into price_snapshots. Runs under GitHub
// Actions every 30 min (satisfies LUL clause 2.3) and writes straight to
// Supabase with the service_role key.
//
// Run locally:  node --env-file=.env.local scripts/ingest-prices.mjs
//
// Freshness: GetSitesPrices returns each site's *current* price every call, so
// we stamp every upserted row with a single run timestamp in ingested_at.
// Unchanged stations hit the PK and simply bump ingested_at; changed stations
// insert a new event row. Either way MAX(ingested_at) advances each run, so the
// 60-min staleness gate (src/lib/freshness.ts) stays green even on quiet
// overnight windows — no manual touch needed in production.
//
// Scope: U91 + core Brisbane postcodes only (CLAUDE.md). "Brisbane" is defined
// by postcode (4000–4179), identical to brisbane_daily_avg_u91 — the L2 region
// is just the query envelope and is deliberately narrowed here.

import {
  BRISBANE_REGION,
  COUNTRY_ID,
  CORE_POSTCODE_MAX,
  CORE_POSTCODE_MIN,
  UNLEADED_FUEL_ID,
  UNLEADED_FUEL_NAME,
  apiGet,
  batchUpsert,
  isSanePriceDollars,
  priceToDollars,
  readEnv,
  supabaseAdmin,
  toUtcIso,
} from "./lib/qld-api.mjs";

// The authoritative core-Brisbane site set: state QLD + postcode in band, read
// from the sites table (kept current by refresh-sites.mjs + the CSV backfill).
// This is what scopes prices to "Brisbane core", matching the aggregate RPC.
async function loadCoreSiteIds(client) {
  const { data, error } = await client
    .from("sites")
    .select("site_id")
    .eq("state", "QLD")
    .gte("postcode", String(CORE_POSTCODE_MIN))
    .lte("postcode", String(CORE_POSTCODE_MAX));
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.site_id));
}

function dedupeByPk(rows) {
  const seen = new Map();
  for (const r of rows) {
    seen.set(`${r.site_id}|${r.fuel_name}|${r.transaction_date_utc}`, r);
  }
  return [...seen.values()];
}

async function main() {
  const token = readEnv("QLD_FUEL_API_TOKEN");
  const client = supabaseAdmin();

  const coreSiteIds = await loadCoreSiteIds(client);
  if (coreSiteIds.size === 0) {
    throw new Error(
      "No core Brisbane sites found (state=QLD, postcode 4000–4179). " +
        "Run refresh-sites.mjs / the CSV backfill first.",
    );
  }
  console.log(`Core Brisbane sites: ${coreSiteIds.size}`);

  const { level, id } = BRISBANE_REGION;
  const resp = await apiGet(
    `/Price/GetSitesPrices?countryId=${COUNTRY_ID}&geoRegionLevel=${level}&geoRegionId=${id}`,
    token,
  );
  const sitePrices = resp.SitePrices ?? [];
  console.log(`Fetched ${sitePrices.length} site prices (Brisbane L2)`);

  const ingestedAt = new Date().toISOString();
  let droppedSentinel = 0;
  let droppedNonCore = 0;

  const rows = [];
  for (const sp of sitePrices) {
    if (sp.FuelId !== UNLEADED_FUEL_ID) continue;
    if (!coreSiteIds.has(sp.SiteId)) {
      droppedNonCore++;
      continue;
    }
    const price = priceToDollars(sp.Price);
    if (!isSanePriceDollars(price)) {
      droppedSentinel++;
      continue;
    }
    rows.push({
      site_id: sp.SiteId,
      fuel_name: UNLEADED_FUEL_NAME,
      price,
      collection_method: sp.CollectionMethod ?? null,
      transaction_date_utc: toUtcIso(sp.TransactionDateUtc),
      data_source: "live_api",
      ingested_at: ingestedAt,
    });
  }

  const deduped = dedupeByPk(rows);
  console.log(
    `U91 core rows: ${deduped.length} ` +
      `(dropped ${droppedNonCore} non-core, ${droppedSentinel} out-of-band)`,
  );

  if (deduped.length === 0) {
    throw new Error(
      "No valid U91 prices to upsert — refusing to no-op silently. " +
        "Check the region/fuel filter and the API response.",
    );
  }

  await batchUpsert(
    client,
    "price_snapshots",
    deduped,
    "site_id,fuel_name,transaction_date_utc",
  );
  console.log(`✓ Upserted ${deduped.length} price_snapshots (ingested_at ${ingestedAt})`);
}

main().catch((err) => {
  console.error("\nPrice ingest failed:", err.message);
  process.exit(1);
});
