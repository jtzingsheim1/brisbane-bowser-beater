// Shared helpers + constants for the QLD Fuel Price Reporting API (live feed).
//
// Used by the ingestion scripts (ingest-prices.mjs, refresh-sites.mjs) that run
// under GitHub Actions and write straight to Supabase via the service_role key.
// Pure Node — never imported by the Next.js bundle.
//
// API facts (verified against prod 2026-05, Postman collection + live calls):
//   base:      https://fppdirectapi-prod.fuelpricesqld.com.au
//   auth:      header "Authorization: FPDAPI SubscriberToken=<token>"
//   countryId: 21 (Australia)
//   regions:   L3 = state (id 1 = QLD), L2 = metro (id 1 = Brisbane), L1 = suburb
//   fuels:     FuelId 2 = Unleaded (QLD's label for U91)
//   price:     integer tenths-of-a-cent → divide by 1000 for $/L (e.g. 1899 → 1.899)
//   sentinel:  9999 means "no price available" — must be dropped
//   load rule: "shouldn't call any method more often than once per minute"
//              (our cron is 30-min / weekly — comfortably inside this)

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASE_URL = "https://fppdirectapi-prod.fuelpricesqld.com.au";
export const COUNTRY_ID = 21;

// Brisbane Metro query region. NB: this is how we *query* the API; "Brisbane"
// for display/aggregation is defined by postcode (see CORE_POSTCODE_*), to
// stay identical to brisbane_daily_avg_u91 and the Phase 2 analysis. The L2
// region is broader (it folds in Gold Coast), so we postcode-filter downstream.
export const BRISBANE_REGION = { level: 2, id: 1 };

// FuelId → canonical fuel_name. MVP is U91 only (CLAUDE.md scope), so we map
// the single id we ingest. Sourced from GetCountryFuelTypes.
export const UNLEADED_FUEL_ID = 2;
export const UNLEADED_FUEL_NAME = "Unleaded";

// Core Brisbane Metro postcode band — the exact filter used by the production
// aggregate (migration 0006) and the analysis pipeline. Outer fringe
// (Ipswich/Logan/Moreton) deliberately excluded.
export const CORE_POSTCODE_MIN = 4000;
export const CORE_POSTCODE_MAX = 4179;

// Price sanity band in $/L (after the /1000 conversion). Drops the 9999
// sentinel ($9.999) and any other implausible values without hard-coding the
// sentinel alone — a defensive band is more robust to future placeholder codes.
export const PRICE_MIN_DOLLARS = 0.5;
export const PRICE_MAX_DOLLARS = 5.0;

// ---------------------------------------------------------------------------
// Env + HTTP
// ---------------------------------------------------------------------------

export function readEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Authenticated GET against the QLD API. Throws on non-2xx with a trimmed body
// so failures surface in the Actions log without dumping a huge payload.
export async function apiGet(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `FPDAPI SubscriberToken=${token}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

// 1899 → 1.899 ($/L). Returns null for non-finite input.
export function priceToDollars(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1000 : null;
}

export function isSanePriceDollars(dollars) {
  return (
    dollars != null &&
    dollars >= PRICE_MIN_DOLLARS &&
    dollars <= PRICE_MAX_DOLLARS
  );
}

// The API reports timestamps as UTC but omits the zone designator
// (e.g. "2026-05-25T04:10:18.237"). Append "Z" so Postgres parses it as UTC
// rather than the server's local zone.
export function toUtcIso(apiTimestamp) {
  const s = String(apiTimestamp);
  return /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export function supabaseAdmin() {
  return createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

const BATCH_SIZE = 500;

export async function batchUpsert(client, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await client
      .from(table)
      .upsert(batch, { onConflict, ignoreDuplicates: false });
    if (error) {
      throw new Error(
        `Upsert into ${table} (rows ${i}..${i + batch.length}) failed: ${error.message}`,
      );
    }
  }
}
