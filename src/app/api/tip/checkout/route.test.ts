import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The checkout session's parameters carry terms decisions (see the comments
// in route.ts), so pin them: the button must not say "Donate", only cards may
// be offered, and nothing in the session params may make Stripe email the
// tipper (account-level receipt emails are a Dashboard setting; see
// docs/deploy-runbook.md).

const create = vi.fn(async () => ({ url: "https://checkout.stripe.test/s" }));

vi.mock("@/lib/tips/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create } } }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkTipRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

const { POST } = await import("./route");

function tipRequest(amountCents: number) {
  return new Request("https://bbb.test/api/tip/checkout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify({ amountCents }),
  });
}

beforeEach(() => {
  vi.stubEnv("BBB_TIPS", "true");
  vi.stubEnv("APP_ORIGIN", "https://bbb.test");
  create.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/tip/checkout", () => {
  it("creates a card-only tip session that never emails the tipper", async () => {
    const res = await POST(tipRequest(500));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/s" });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    expect(params.mode).toBe("payment");
    expect(params.submit_type).toBe("pay");
    expect(params.managed_payments).toEqual({ enabled: false });
    expect(params.success_url).toBe("https://bbb.test/tip/thanks");
    expect(params.cancel_url).toBe("https://bbb.test/");
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).not.toHaveProperty("receipt_email");
    expect(params).not.toHaveProperty("invoice_creation");
    expect(params).not.toHaveProperty("customer_email");
    const name = (
      params.line_items as {
        price_data: { product_data: { name: string } };
      }[]
    )[0].price_data.product_data.name;
    expect(name).toBe("Tip for Brisbane Bowser Beater");
    expect(JSON.stringify(params).toLowerCase()).not.toContain("donat");
  });

  it("is not found while the tip jar is flagged off", async () => {
    vi.stubEnv("BBB_TIPS", "");
    const res = await POST(tipRequest(500));
    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });
});
