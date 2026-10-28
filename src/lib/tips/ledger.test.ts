import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Duplicate delivery: Stripe retries a webhook until it sees a 2xx, and can
// redeliver an event it already got a 2xx for. The ledger must record each
// event once, and a replay must still be acknowledged (a 5xx would make
// Stripe retry it indefinitely).
//
// The stand-in table below mirrors tip_ledger's primary key on
// stripe_event_id: a plain insert of an existing key fails, as Postgres would,
// and an upsert honours onConflict / ignoreDuplicates.

type Row = Record<string, unknown>;

const table = new Map<string, Row>();

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: () => ({
    from(name: string) {
      if (name !== "tip_ledger") throw new Error(`unexpected table ${name}`);
      return {
        insert(row: Row) {
          const key = String(row.stripe_event_id);
          if (table.has(key)) {
            return Promise.resolve({
              error: { code: "23505", message: "duplicate key value" },
            });
          }
          table.set(key, row);
          return Promise.resolve({ error: null });
        },
        upsert(
          row: Row,
          opts: { onConflict?: string; ignoreDuplicates?: boolean } = {},
        ) {
          // PostgREST resolves conflicts on the primary key when onConflict
          // is omitted, and stripe_event_id is the primary key.
          if ((opts.onConflict ?? "stripe_event_id") !== "stripe_event_id") {
            return Promise.resolve({
              error: { code: "23505", message: "duplicate key value" },
            });
          }
          const key = String(row.stripe_event_id);
          if (table.has(key) && opts.ignoreDuplicates) {
            return Promise.resolve({ error: null });
          }
          table.set(key, row);
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

const SECRET = "whsec_test_secret_for_unit_tests";

const EVENT = {
  id: "evt_test_dup_0001",
  object: "event",
  api_version: "2026-01-01",
  created: 1_753_056_000,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_dup",
      object: "checkout.session",
      amount_total: 500,
      currency: "aud",
      payment_intent: "pi_test_dup",
      payment_status: "paid",
      status: "complete",
    },
  },
};

const PAYLOAD = JSON.stringify(EVENT);

function deliver(post: (req: Request) => Promise<Response>) {
  return post(
    new Request("https://example.com/api/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload: PAYLOAD,
          secret: SECRET,
          timestamp: Math.floor(Date.now() / 1000),
        }),
        "content-type": "application/json",
      },
      body: PAYLOAD,
    }),
  );
}

describe("tip ledger duplicate delivery", () => {
  beforeEach(() => {
    table.clear();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a redelivered event once and acknowledges both deliveries", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");

    const first = await deliver(POST);
    const second = await deliver(POST);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(table.size).toBe(1);
    expect(table.get("evt_test_dup_0001")).toMatchObject({
      checkout_session_id: "cs_test_dup",
      amount_total: 500,
    });
  });

  it("keeps the first row when a replay arrives", async () => {
    const { recordTipEvent, mapEventToLedgerRow } = await import("./ledger");
    const row = mapEventToLedgerRow(EVENT as unknown as Stripe.Event)!;

    await recordTipEvent(row);
    await recordTipEvent({ ...row, status: "replayed" });

    expect(table.size).toBe(1);
    expect(table.get(row.stripe_event_id)).toMatchObject({ status: "paid" });
  });
});
