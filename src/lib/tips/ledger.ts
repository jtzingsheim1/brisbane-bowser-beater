import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/server";

// Reconciliation ledger for the tip jar: one row per verified Stripe webhook
// event, so every checkout is traceable to a signed event.
//
// Deliberately minimal: no donor PII is stored — donor identity lives in
// Stripe. See README (privacy). A Stripe checkout.session event carries the
// donor's email/name in `customer_details`; the mapper below is a strict
// whitelist, so none of that ever reaches our database — only opaque Stripe
// IDs, the amount, and status. Keep it a whitelist: never store the raw event.

// The checkout lifecycle events worth a ledger row. Everything else Stripe
// might send (charge.*, payment_intent.*, …) is acknowledged but not recorded.
//
// Reconciliation note: this is an append-only *event* log — one row per event,
// not one row per payment. For a delayed payment method both
// checkout.session.completed and checkout.session.async_payment_succeeded can
// fire for the same payment, each carrying the same amount_total. So a totals
// query must filter to a single terminal event type (e.g. status = 'paid' on
// checkout.session.completed), never blindly SUM(amount_total) across rows.
const LEDGER_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

export type TipLedgerRow = {
  stripe_event_id: string;
  event_type: string;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  amount_total: number | null;
  currency: string | null;
  status: string;
  occurred_at: string;
};

export function mapEventToLedgerRow(event: Stripe.Event): TipLedgerRow | null {
  if (!LEDGER_EVENT_TYPES.has(event.type)) return null;
  const session = event.data.object as Stripe.Checkout.Session;
  const paymentIntent = session.payment_intent;
  // Validate the timestamp before constructing a Date — a non-finite `created`
  // would otherwise throw a RangeError. The webhook route catches this and
  // drops the event with a 400 rather than looping on a Stripe 500-retry.
  if (!Number.isFinite(event.created)) {
    throw new Error("event.created is not a finite timestamp");
  }
  return {
    stripe_event_id: event.id,
    event_type: event.type,
    checkout_session_id: session.id ?? null,
    payment_intent_id:
      typeof paymentIntent === "string"
        ? paymentIntent
        : (paymentIntent?.id ?? null),
    amount_total: session.amount_total ?? null,
    currency: session.currency ?? null,
    status: session.payment_status ?? "unknown",
    occurred_at: new Date(event.created * 1000).toISOString(),
  };
}

// Idempotent on the event ID (the table's primary key): Stripe retries
// deliveries until it sees a 2xx, and a replayed event must not double-count.
export async function recordTipEvent(row: TipLedgerRow): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("tip_ledger")
    .upsert(row, { onConflict: "stripe_event_id", ignoreDuplicates: true });
  if (error) throw error;
}
