import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Thanks for the shout — Brisbane Bowser Beater",
};

// Static landing page after a completed Stripe Checkout. Deliberately knows
// nothing about the payment — no session lookup, no amount, no name — so the
// zero-donor-PII posture holds even here. Stripe handles the receipt.

export default function TipThanksPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-3xl">
        Legend. Thanks for the shout. ⛽
      </h1>
      <p className="mt-3 max-w-prose text-base text-zinc-600 dark:text-zinc-400">
        Your support keeps this site on the road. Stripe handles your receipt
        &mdash; true to form, we never see your details, and our ledger keeps
        only an anonymous record of the payment.
      </p>
      <p className="mt-6">
        <Link
          href="/"
          className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:no-underline dark:text-zinc-300"
        >
          Back to the forecast
        </Link>
      </p>
    </main>
  );
}
