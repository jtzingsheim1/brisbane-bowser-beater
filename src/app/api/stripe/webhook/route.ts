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
// party who can produce a valid signature is Stripe. To keep that reasoning
// honest about the work done *before* verification, we cap the body size up
// front so an unsigned flood can't force large buffers/HMACs (see MAX_BODY_BYTES).

// Real Stripe webhook payloads are a few KB; 64 KB is a generous ceiling. A
// request larger than this can't be a legitimate signed event, so reject it
// before buffering the body into memory.
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Webhooks are temporarily unavailable." },
      { status: 503 },
    );
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  // Reject oversized bodies before reading them, so unsigned junk can't force
  // an arbitrarily large in-memory buffer ahead of the (cheap) signature check.
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  // Raw body, not parsed JSON — the signature is computed over the exact bytes.
  const payload = await req.text();
  if (payload.length > MAX_BODY_BYTES) {
    // Guard again in case Content-Length was absent or understated.
    return new Response("Payload too large", { status: 413 });
  }

  let event;
  try {
    event = await constructVerifiedEvent(payload, signature, secret);
  } catch (error) {
    // Log only the message — the thrown StripeSignatureVerificationError carries
    // the raw request body (which, on a genuine mis-keyed delivery, contains
    // donor PII) as a property, so never log the whole object.
    console.error(
      "[tips] webhook signature verification failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return new Response("Invalid signature", { status: 400 });
  }

  let row;
  try {
    row = mapEventToLedgerRow(event);
  } catch (error) {
    // A verified event with an unexpected shape (e.g. a non-finite timestamp)
    // shouldn't wedge the endpoint into a 500 → Stripe-retry loop. Drop it with
    // a 400 so Stripe stops redelivering. Log the message only, not the event.
    console.error(
      "[tips] could not map verified event; dropping:",
      error instanceof Error ? error.message : "unknown error",
    );
    return new Response("Unprocessable event", { status: 400 });
  }
  if (!row) {
    // Verified but not a checkout lifecycle event — acknowledge so Stripe
    // doesn't retry, record nothing.
    return Response.json({ received: true, recorded: false });
  }

  try {
    await recordTipEvent(row);
  } catch (error) {
    // 5xx tells Stripe to retry the delivery; the ledger upsert is idempotent
    // on the event ID, so retries can't double-count. Log the message only (the
    // row is PII-free, but keep the discipline uniform).
    console.error(
      "[tips] ledger write failed; asking Stripe to retry:",
      error instanceof Error ? error.message : "unknown error",
    );
    return new Response("Ledger write failed", { status: 500 });
  }

  return Response.json({ received: true, recorded: true });
}
