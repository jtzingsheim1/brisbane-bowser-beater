import Stripe from "stripe";

// Server-only Stripe client. Lazy like the rest of the env reads in src/lib —
// the build never needs the key, and an unconfigured deployment degrades to
// "tips unavailable" rather than crashing at import time.

let cached: Stripe | null = null;
let resolved = false;

export function getStripe(): Stripe | null {
  if (resolved) return cached;
  resolved = true;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    cached = null;
    return null;
  }
  // Pin the API version explicitly to the one this SDK's types were generated
  // against. Omitting it makes Stripe use the *account's* dashboard-default
  // version at runtime, which can silently drift from the typed version and
  // change response shapes under us; pinning keeps runtime and types locked.
  cached = new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
  return cached;
}
