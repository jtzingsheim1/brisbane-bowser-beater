// Dev-only helper. Bumps price_snapshots.ingested_at to now() so the
// staleness gate (60-min window) passes during local testing when there's
// no live cron yet. Run with:
//   node --env-file=.env.local scripts/touch-freshness.mjs
//
// Why this exists: the CSV backfill upserts on conflict and never rewrites
// ingested_at, so re-running it does NOT refresh freshness for existing rows.
// This nudges the timestamps directly. Never needed once the live 30-min
// cron is running. Never prints key values.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SECRET_KEY);
const now = new Date().toISOString();

console.log("Bumping price_snapshots.ingested_at to now()…");
const { error, count } = await client
  .from("price_snapshots")
  .update({ ingested_at: now }, { count: "exact" })
  .gte("site_id", 0);

if (error) {
  console.error(`  ✗ update failed: ${error.code ?? "???"} — ${error.message}`);
  process.exit(1);
}

console.log(`  ✓ touched ${count ?? "?"} rows; ingested_at = ${now}`);
console.log("Staleness gate should clear within ~60s (freshness cache TTL).");
