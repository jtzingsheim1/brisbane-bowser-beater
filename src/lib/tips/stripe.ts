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
  // No explicit apiVersion: modern stripe-node pins requests to the API
  // version its types were generated against (stripe.core.js falls back to
  // the SDK's bundled DEFAULT_API_VERSION and always sends Stripe-Version),
  // so runtime and types stay locked together by construction — and SDK
  // bumps can't break the build against a hand-pinned literal. (The old
  // "omitting falls back to the account's dashboard default" behaviour is
  // legacy stripe-node; it no longer applies.)
  cached = new Stripe(key);
  return cached;
}
