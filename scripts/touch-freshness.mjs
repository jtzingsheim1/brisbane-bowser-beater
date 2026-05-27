// Dev-only helper. Bumps price_snapshots.ingested_at to now() so the
// staleness gate (60-min window) passes during local testing when there's
// no live cron yet. Run with:
//   node --env-file=.env.local scripts/touch-freshness.mjs
//
// Why this exists: the CSV backfill upserts on conflict and never rewrites
// ingested_at, so re-running it does NOT refresh freshness for existing rows.
// This nudges the timestamp directly. Never needed once the live 30-min
// cron is running. Never prints key values.
//
// The staleness gate (src/lib/freshness.ts) only reads MAX(ingested_at) — the
// single most-recent row — so we bump just that one row. Rewriting every row
// is unnecessary and times out once the table grows (the backfill is large).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

// Safety guard: this rewrites ingested_at and is dev-only. Require an explicit
// --force so it can never run by accident (e.g. against the live DB, where it
// would mask a real staleness condition).
if (!process.argv.includes("--force")) {
  console.error(
    "Refusing to run without --force. This dev-only helper rewrites " +
      "ingested_at on the latest price_snapshots row — never run it against a live DB.",
  );
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SECRET_KEY);
const now = new Date().toISOString();

console.log("Bumping the latest price_snapshots.ingested_at to now()…");

// Find the most-recent snapshot by event time and bump only its ingested_at.
// MAX(ingested_at) is all the gate reads, so this one row sets it.
const { data: latest, error: selError } = await client
  .from("price_snapshots")
  .select("site_id, fuel_name, transaction_date_utc")
  .order("transaction_date_utc", { ascending: false })
  .limit(1)
  .maybeSingle();

if (selError) {
  console.error(`  ✗ lookup failed: ${selError.code ?? "???"} — ${selError.message}`);
  process.exit(1);
}
if (!latest) {
  console.error("  ✗ no rows in price_snapshots — nothing to touch.");
  process.exit(1);
}

const { error } = await client
  .from("price_snapshots")
  .update({ ingested_at: now })
  .eq("site_id", latest.site_id)
  .eq("fuel_name", latest.fuel_name)
  .eq("transaction_date_utc", latest.transaction_date_utc);

if (error) {
  console.error(`  ✗ update failed: ${error.code ?? "???"} — ${error.message}`);
  process.exit(1);
}

console.log(`  ✓ touched latest row; ingested_at = ${now}`);
console.log("Staleness gate should clear within ~60s (freshness cache TTL).");
