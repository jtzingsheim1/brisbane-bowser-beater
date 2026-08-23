import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

// Both factories memoise a module-level singleton: a cold-start render with a
// cache miss calls these from several data paths, and each client carries its
// own fetch plumbing worth constructing once. Env vars are read on first use
// (unchanged failure mode — a missing var still throws at the first call, not
// at import time) and never change within a running instance.
let readOnlyClient: SupabaseClient | undefined;
let adminClient: SupabaseClient | undefined;

/**
 * Server-side read client using the publishable (anon) key.
 * Subject to RLS — only sees rows that policies allow `anon` to SELECT.
 */
export function supabaseReadOnly(): SupabaseClient {
  readOnlyClient ??= createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } },
  );
  return readOnlyClient;
}

/**
 * Server-side admin client using the secret (service_role) key.
 * Bypasses RLS. Only use server-side for trusted operations (cron writes).
 * Never expose this to a browser bundle.
 */
export function supabaseAdmin(): SupabaseClient {
  adminClient ??= createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
  return adminClient;
}
