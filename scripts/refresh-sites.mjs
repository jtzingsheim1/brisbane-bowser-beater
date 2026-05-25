// Weekly sites refresh for the Brisbane Metro region.
//
// Pulls full site details for the Brisbane L2 region, resolves brand and
// region reference data, and upserts denormalised station rows into `sites`.
// The 30-min price ingest depends on these rows (postcode + state) to scope
// prices to core Brisbane. Runs weekly under GitHub Actions (LUL 2.3 allows
// 24 hr for non-price data; weekly is conservative and stations rarely move).
//
// Run locally:  node --env-file=.env.local scripts/refresh-sites.mjs
//
// GetFullSiteDetails returns minified records (S/A/N/B/P/G1..G5/Lat/Lng/M).
// There are no state/suburb strings, but the geo-region IDs resolve them:
// G3 → state (level-3 region), G1 → suburb (level-1 region). Brand id B
// resolves via GetCountryBrands.

import {
  BRISBANE_REGION,
  COUNTRY_ID,
  apiGet,
  batchUpsert,
  readEnv,
  supabaseAdmin,
  toUtcIso,
} from "./lib/qld-api.mjs";

// Build {GeoRegionId → label} maps for a given level. Region IDs are only
// unique within a level, so we key per level (id 1 is QLD at L3, Brisbane at
// L2, and a suburb at L1).
function regionMapByLevel(regions, level, labelKey) {
  const m = new Map();
  for (const r of regions) {
    if (r.GeoRegionLevel === level) m.set(r.GeoRegionId, r[labelKey]);
  }
  return m;
}

function emptyToNull(s) {
  return s == null || s === "" ? null : s;
}

async function main() {
  const token = readEnv("QLD_FUEL_API_TOKEN");
  const client = supabaseAdmin();
  const { level, id } = BRISBANE_REGION;

  const [siteResp, brandResp, regionResp] = await Promise.all([
    apiGet(
      `/Subscriber/GetFullSiteDetails?countryId=${COUNTRY_ID}&geoRegionLevel=${level}&geoRegionId=${id}`,
      token,
    ),
    apiGet(`/Subscriber/GetCountryBrands?countryId=${COUNTRY_ID}`, token),
    apiGet(`/Subscriber/GetCountryGeographicRegions?countryId=${COUNTRY_ID}`, token),
  ]);

  const sites = siteResp.S ?? [];
  const brandName = new Map((brandResp.Brands ?? []).map((b) => [b.BrandId, b.Name]));
  const regions = regionResp.GeographicRegions ?? [];
  const stateByG3 = regionMapByLevel(regions, 3, "Abbrev"); // e.g. 1 → "QLD"
  const suburbByG1 = regionMapByLevel(regions, 1, "Name"); // e.g. 152 → "Newstead"

  console.log(
    `Sites: ${sites.length} | brands: ${brandName.size} | regions: ${regions.length}`,
  );

  const ingestedAt = new Date().toISOString();
  const rows = sites.map((s) => ({
    site_id: s.S,
    brand_id: s.B ?? null,
    brand_name: brandName.get(s.B) ?? null,
    name: s.N,
    address: s.A,
    postcode: emptyToNull(s.P),
    suburb: suburbByG1.get(s.G1) ?? null,
    state: stateByG3.get(s.G3) ?? null,
    lat: Number.isFinite(s.Lat) ? s.Lat : null,
    lng: Number.isFinite(s.Lng) ? s.Lng : null,
    g1: s.G1 ?? null,
    g2: s.G2 ?? null,
    g3: s.G3 ?? null,
    g4: s.G4 ?? null,
    g5: s.G5 ?? null,
    last_modified_at: s.M ? toUtcIso(s.M) : null,
    ingested_at: ingestedAt,
  }));

  if (rows.length === 0) {
    throw new Error("GetFullSiteDetails returned no sites — refusing to upsert nothing.");
  }

  await batchUpsert(client, "sites", rows, "site_id");

  const core = rows.filter(
    (r) => r.state === "QLD" && r.postcode >= "4000" && r.postcode <= "4179",
  );
  console.log(
    `✓ Upserted ${rows.length} sites (${core.length} in core postcode 4000–4179)`,
  );
}

main().catch((err) => {
  console.error("\nSites refresh failed:", err.message);
  process.exit(1);
});
