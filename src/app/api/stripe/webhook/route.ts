import { mapEventToLedgerRow, recordTipEvent } from "@/lib/tips/ledger";
import { constructVerifiedEvent } from "@/lib/tips/webhook";

export const runtime = "nodejs";

// Stripe webhook receiver. Verifies the signature against the endpoint's
// signing secret, then records checkout lifecycle events into the tip_ledger
// reconciliation table (opaque IDs + amount only — see src/lib/tips/ledger.ts
// for the deliberate PII whitelist).
//
// Deliberately NOT gated on the BBB_TIPS flag: if the tip jar UI is ever
// flipped off while a checkout is in flight (or Stripe retries an old
// delivery), the event should still land in the ledger. The signature check is
// the gate — unsigned traffic gets a cheap 400. No rate limit either: the only
// party who can produce a valid signature is Stripe.

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Webhook not configured. Set STRIPE_WEBHOOK_SECRET." },
      { status: 503 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // Raw body, not parsed JSON — the signature is computed over the exact bytes.
  const payload = await req.text();

  let event;
  try {
    event = await constructVerifiedEvent(payload, signature, secret);
  } catch (error) {
    console.error("[tips] webhook signature verification failed", error);
    return new Response("Invalid signature", { status: 400 });
  }

  const row = mapEventToLedgerRow(event);
  if (!row) {
    // Verified but not a checkout lifecycle event — acknowledge so Stripe
    // doesn't retry, record nothing.
    return Response.json({ received: true, recorded: false });
  }

  try {
    await recordTipEvent(row);
  } catch (error) {
    // 5xx tells Stripe to retry the delivery; the ledger upsert is idempotent
    // on the event ID, so retries can't double-count.
    console.error("[tips] ledger write failed; asking Stripe to retry", error);
    return new Response("Ledger write failed", { status: 500 });
  }

  return Response.json({ received: true, recorded: true });
}
