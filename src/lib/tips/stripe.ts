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
  // No apiVersion override: the SDK pins the API version its types are
  // generated against, which is the only version this code is written for.
  cached = new Stripe(key);
  return cached;
}
