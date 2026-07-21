import { checkTipRateLimit } from "@/lib/rate-limit";
import {
  isValidTipAmountCents,
  TIP_CURRENCY,
  tipsEnabled,
} from "@/lib/tips/config";
import { getStripe } from "@/lib/tips/stripe";
import { getClientIp } from "@/lib/usage";

export const runtime = "nodejs";

// Creates a Stripe-hosted Checkout session for a tip and returns its URL for
// the browser to redirect to. Card details are entered on Stripe's page and
// never touch this server — our involvement ends at "here's the amount".

function resolveOrigin(req: Request): string | null {
  // A configured canonical origin wins, so the redirect target can't be set by
  // a forged Host header in production. Strip any trailing slash to keep the
  // interpolated paths clean. Server-only (no NEXT_PUBLIC_ prefix) so it's
  // changeable from the dashboard without a rebuild.
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host");
  if (!host) return null;
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  if (!tipsEnabled()) {
    // Feature-flagged off → behave as though the endpoint doesn't exist.
    return new Response("Not found", { status: 404 });
  }
  const stripe = getStripe();
  if (!stripe) {
    return Response.json(
      { error: "Tips are temporarily unavailable." },
      { status: 503 },
    );
  }

  // Same skip-when-no-IP posture as the agent route: don't bucket every
  // header-less request together and cause shared false 429s.
  const ip = getClientIp(req.headers);
  if (ip) {
    const rate = await checkTipRateLimit(ip);
    if (!rate.allowed) {
      return Response.json(
        { error: "Too many requests — give it a moment and try again." },
        {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        },
      );
    }
  }

  let body: { amountCents?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const amountCents = body.amountCents;
  if (!isValidTipAmountCents(amountCents)) {
    return new Response("Invalid amount", { status: 400 });
  }

  // Redirect targets for after checkout. Prefer a server-configured canonical
  // origin (NEXT_PUBLIC_SITE_URL) so a forged Host header can't set the
  // post-payment redirect at all. Fall back to the request headers when it's
  // unset (local dev / preview) — worst case there, a forged Host only sends
  // the *payer's own browser* elsewhere after they pay (funds still go to the
  // real account), so the header carries no more trust than that.
  const origin = resolveOrigin(req);
  if (!origin) {
    return new Response("Missing host", { status: 400 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      submit_type: "donate",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: TIP_CURRENCY,
            unit_amount: amountCents,
            product_data: { name: "Support Brisbane Bowser Beater" },
          },
        },
      ],
      success_url: `${origin}/tip/thanks`,
      cancel_url: `${origin}/`,
    });
    if (!session.url) {
      throw new Error("Checkout session created without a redirect URL");
    }
    return Response.json({ url: session.url });
  } catch (error) {
    console.error("[tips] checkout session creation failed", error);
    return Response.json(
      { error: "Couldn't start checkout — please try again shortly." },
      { status: 502 },
    );
  }
}
