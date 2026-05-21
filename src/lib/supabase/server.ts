import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

/**
 * Server-side read client using the publishable (anon) key.
 * Subject to RLS — only sees rows that policies allow `anon` to SELECT.
 */
export function supabaseReadOnly(): SupabaseClient {
  return createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } },
  );
}

/**
 * Server-side admin client using the secret (service_role) key.
 * Bypasses RLS. Only use server-side for trusted operations (cron writes).
 * Never expose this to a browser bundle.
 */
export function supabaseAdmin(): SupabaseClient {
  return createClient(
    readEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}
