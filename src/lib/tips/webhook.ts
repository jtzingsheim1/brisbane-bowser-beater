import Stripe from "stripe";

// Signature verification for incoming Stripe webhooks, isolated here so it can
// be unit-tested (valid / tampered / replayed) without touching the route or
// any env. Verification is what makes a ledger row trustworthy: a row is only
// ever written for an event Stripe provably signed.

// Maximum age of a webhook's signed timestamp. Stripe signs the timestamp into
// the payload signature, so an attacker replaying a captured delivery outside
// this window is rejected even though the signature itself still matches.
// 300 s is Stripe's own recommended default.
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export async function constructVerifiedEvent(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<Stripe.Event> {
  // Async variant: works on every runtime (uses SubtleCrypto when Node's
  // crypto module is unavailable) and keeps this module runtime-agnostic.
  return await Stripe.webhooks.constructEventAsync(
    payload,
    signatureHeader,
    secret,
    SIGNATURE_TOLERANCE_SECONDS,
  );
}
