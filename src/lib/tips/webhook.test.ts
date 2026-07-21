import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  isValidTipAmountCents,
  MAX_TIP_CENTS,
  MIN_TIP_CENTS,
  TIP_TIERS,
} from "./config";
import { mapEventToLedgerRow, type TipLedgerRow } from "./ledger";
import { constructVerifiedEvent } from "./webhook";

// The webhook receiver's two trust-critical pieces, tested without a network:
//   1. Signature verification (valid / tampered / wrong secret / replayed) —
//      a ledger row must only ever come from an event Stripe provably signed.
//   2. The event→row mapper's PII whitelist — a checkout event carries the
//      donor's email and name, and none of it may reach the database.

const SECRET = "whsec_test_secret_for_unit_tests";

// A realistic checkout.session.completed event, including the donor PII that
// Stripe genuinely sends and the mapper must drop.
const COMPLETED_EVENT = {
  id: "evt_test_0001",
  object: "event",
  api_version: "2026-01-01",
  created: 1_753_056_000, // 2025-07-21T00:00:00Z
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_abc123",
      object: "checkout.session",
      amount_total: 500,
      currency: "aud",
      payment_intent: "pi_test_xyz789",
      payment_status: "paid",
      status: "complete",
      customer_details: {
        email: "donor@example.com",
        name: "Generous Donor",
        phone: "+61400000000",
      },
    },
  },
} as const;

const PAYLOAD = JSON.stringify(COMPLETED_EVENT);

function sign(payload: string, opts: { secret?: string; timestamp?: number } = {}) {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? SECRET,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
  });
}

describe("constructVerifiedEvent (signature verification)", () => {
  it("accepts a correctly signed payload and round-trips the event", async () => {
    const event = await constructVerifiedEvent(PAYLOAD, sign(PAYLOAD), SECRET);
    expect(event.id).toBe("evt_test_0001");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a payload tampered with after signing", async () => {
    const header = sign(PAYLOAD);
    const tampered = PAYLOAD.replace('"amount_total":500', '"amount_total":1');
    await expect(
      constructVerifiedEvent(tampered, header, SECRET),
    ).rejects.toThrow();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const header = sign(PAYLOAD, { secret: "whsec_someone_elses_secret" });
    await expect(
      constructVerifiedEvent(PAYLOAD, header, SECRET),
    ).rejects.toThrow();
  });

  it("rejects a replayed delivery whose signed timestamp is stale", async () => {
    // Valid signature, but signed 10 minutes ago — outside the 300 s tolerance,
    // so a captured-and-replayed delivery is refused.
    const stale = Math.floor(Date.now() / 1000) - 600;
    const header = sign(PAYLOAD, { timestamp: stale });
    await expect(
      constructVerifiedEvent(PAYLOAD, header, SECRET),
    ).rejects.toThrow();
  });
});

describe("mapEventToLedgerRow (PII whitelist)", () => {
  const event = COMPLETED_EVENT as unknown as Stripe.Event;

  it("extracts exactly the whitelisted reconciliation fields", () => {
    const row = mapEventToLedgerRow(event);
    expect(row).toEqual<TipLedgerRow>({
      stripe_event_id: "evt_test_0001",
      event_type: "checkout.session.completed",
      checkout_session_id: "cs_test_abc123",
      payment_intent_id: "pi_test_xyz789",
      amount_total: 500,
      currency: "aud",
      status: "paid",
      occurred_at: new Date(1_753_056_000 * 1000).toISOString(),
    });
  });

  it("lets no donor PII through, even though the event contains it", () => {
    const serialized = JSON.stringify(mapEventToLedgerRow(event));
    expect(serialized).not.toContain("donor@example.com");
    expect(serialized).not.toContain("Generous Donor");
    expect(serialized).not.toContain("+61400000000");
    expect(serialized).not.toContain("customer");
  });

  it("records nothing for event types outside the checkout lifecycle", () => {
    const other = {
      ...COMPLETED_EVENT,
      type: "charge.succeeded",
    } as unknown as Stripe.Event;
    expect(mapEventToLedgerRow(other)).toBeNull();
  });

  it("throws (rather than producing a bad Date) on a non-finite timestamp", () => {
    // A verified-but-malformed event must not crash the route with a 500 that
    // makes Stripe retry forever; the route catches this throw and 400s.
    const malformed = {
      ...COMPLETED_EVENT,
      created: Number.NaN,
    } as unknown as Stripe.Event;
    expect(() => mapEventToLedgerRow(malformed)).toThrow();
  });
});

describe("webhook route logging hygiene", () => {
  it("does not log donor PII when signature verification fails", async () => {
    // The signature-failure path must log only the error message — never the
    // thrown Stripe error object, which carries the raw request body (donor
    // email/name/phone) as a property.
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    const { POST } = await import("@/app/api/stripe/webhook/route");

    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      });

    try {
      const res = await POST(
        new Request("https://example.com/api/stripe/webhook", {
          method: "POST",
          headers: {
            "stripe-signature": "t=1,v1=deadbeef", // deliberately invalid
            "content-type": "application/json",
          },
          body: PAYLOAD, // contains donor@example.com / Generous Donor / phone
        }),
      );
      expect(res.status).toBe(400);
    } finally {
      spy.mockRestore();
    }

    const blob = logged.join("\n");
    expect(blob).not.toContain("donor@example.com");
    expect(blob).not.toContain("Generous Donor");
    expect(blob).not.toContain("+61400000000");
  });
});

describe("isValidTipAmountCents (server-side amount validation)", () => {
  it("accepts every advertised tier and the custom bounds", () => {
    for (const tier of TIP_TIERS) {
      expect(isValidTipAmountCents(tier.amountCents)).toBe(true);
    }
    expect(isValidTipAmountCents(MIN_TIP_CENTS)).toBe(true);
    expect(isValidTipAmountCents(MAX_TIP_CENTS)).toBe(true);
  });

  it("rejects out-of-bounds, fractional, and non-numeric amounts", () => {
    expect(isValidTipAmountCents(MIN_TIP_CENTS - 1)).toBe(false);
    expect(isValidTipAmountCents(MAX_TIP_CENTS + 1)).toBe(false);
    expect(isValidTipAmountCents(250.5)).toBe(false);
    expect(isValidTipAmountCents(-500)).toBe(false);
    expect(isValidTipAmountCents("500")).toBe(false);
    expect(isValidTipAmountCents(null)).toBe(false);
    expect(isValidTipAmountCents(Number.NaN)).toBe(false);
  });
});
