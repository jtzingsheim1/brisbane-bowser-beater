// One-off connectivity check. Run with:
//   node --env-file=.env.local scripts/verify-supabase.mjs
//
// Exercises both keys against the data API by querying a deliberately
// nonexistent table. A "table not found" error means the key authenticated;
// any other error (typically auth-related) means something's wrong.
//
// Never prints key values.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing = [];
if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
if (!PUBLISHABLE_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
if (!SECRET_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length > 0) {
  console.error(`Missing env vars: ${missing.join(", ")}`);
  console.error("Have you copied .env.local.example to .env.local and filled it in?");
  process.exit(1);
}

async function ping(label, client) {
  const { error } = await client
    .from("_supabase_connection_check")
    .select("*")
    .limit(1);

  if (!error) {
    console.log(`  ✓ ${label} (unexpected: no error from nonexistent table)`);
    return true;
  }

  const msg = error.message?.toLowerCase() ?? "";
  const tableNotFound =
    error.code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table");

  if (tableNotFound) {
    console.log(`  ✓ ${label}`);
    return true;
  }

  console.error(`  ✗ ${label}: ${error.code ?? "???"} — ${error.message}`);
  return false;
}

console.log("Verifying Supabase connection...");
const ok1 = await ping("Publishable key", createClient(SUPABASE_URL, PUBLISHABLE_KEY));
const ok2 = await ping("Secret key", createClient(SUPABASE_URL, SECRET_KEY));

if (!ok1 || !ok2) {
  console.error(
    "\nOne or more checks failed. Verify your .env.local values match Project Settings → API in Supabase.",
  );
  process.exit(1);
}

console.log("\n✓ Supabase connection verified.");
