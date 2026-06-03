// Pure CSV → row-object helpers used by the QLD open-data backfill script.
// Lifted out of scripts/backfill-csv.mjs so the test suite can exercise them
// without a Supabase client or network access.

import { parse } from "csv-parse/sync";

// QLD has shipped two different header conventions inside the 2026 dataset:
//   • Underscores: "Site_Name", "Fuel_Type"   (Jan, Feb, Apr, May 2026)
//   • Spaces:      "Site Name", "Fuel Type"   (Mar 2026)
// Both describe the same columns. We normalise space → underscore at parse
// time so downstream transforms can read a single shape. SiteId, Price, and
// TransactionDateutc contain neither character and pass through unchanged.
export function parseRows(csvText) {
  return parse(csvText, {
    columns: (header) => header.map((h) => h.replace(/ /g, "_")),
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
}

// "4/01/2026 20:42" → "2026-01-04T20:42:00Z"
export function parseDateUtc(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Unrecognised date format: "${s}"`);
  const [, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00Z`;
}

// "1860" → 1.860 (CSV stores price in tenths-of-cents)
export function parsePrice(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Bad price: "${s}"`);
  return n / 1000;
}

export function toNumberOrNull(s) {
  if (s === "" || s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function dedupeBy(rows, keyFn) {
  const seen = new Map();
  for (const r of rows) seen.set(keyFn(r), r); // last wins
  return [...seen.values()];
}

export function transformSite(row) {
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

export function transformPrice(row) {
  return {
    site_id: Number(row.SiteId),
    fuel_name: row.Fuel_Type,
    price: parsePrice(row.Price),
    transaction_date_utc: parseDateUtc(row.TransactionDateutc),
    data_source: "csv_backfill",
    collection_method: null,
  };
}
