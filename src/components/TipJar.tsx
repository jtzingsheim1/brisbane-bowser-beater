"use client";

import { useState } from "react";
import {
  MAX_TIP_CENTS,
  MIN_TIP_CENTS,
  TIP_TIERS,
} from "@/lib/tips/config";

// "Shout me a litre" — a quiet support panel. Picking an amount POSTs to
// /api/tip/checkout and redirects the browser to Stripe-hosted Checkout, so
// card details never touch this site. Rendered only when the server flag
// allows it (see page.tsx); kept visually low-key so it reads as a tip jar on
// the counter, not a paywall.

const MIN_DOLLARS = MIN_TIP_CENTS / 100;
const MAX_DOLLARS = MAX_TIP_CENTS / 100;

export default function TipJar() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  async function startCheckout(amountCents: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tip/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountCents }),
      });
      if (!res.ok) {
        const detail = await res
          .json()
          .then((d: { error?: string }) => d.error)
          .catch(() => null);
        throw new Error(detail ?? "Couldn't start checkout.");
      }
      const { url } = (await res.json()) as { url: string };
      window.location.assign(url);
      // Keep the panel disabled while the browser navigates away.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start checkout.");
      setBusy(false);
    }
  }

  function submitCustom() {
    const dollars = Number(custom);
    if (
      !Number.isFinite(dollars) ||
      dollars < MIN_DOLLARS ||
      dollars > MAX_DOLLARS
    ) {
      setError(`Pick an amount between $${MIN_DOLLARS} and $${MAX_DOLLARS}.`);
      return;
    }
    void startCheckout(Math.round(dollars * 100));
  }

  return (
    <div className="rounded-lg border border-zinc-200 px-5 py-4 dark:border-zinc-800">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
        Shout me a litre
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        If this site has saved you a few bucks at the bowser, you can shout the
        developer some fuel back. Payments run through Stripe&rsquo;s hosted
        checkout &mdash; your card details and identity stay with Stripe, and
        our books hold nothing but an anonymous receipt ID.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {TIP_TIERS.map((tier) => (
          <button
            key={tier.amountCents}
            type="button"
            disabled={busy}
            onClick={() => void startCheckout(tier.amountCents)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-colors hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-950/40"
          >
            {tier.label} &middot; ${tier.dollars}
          </button>
        ))}
        <div className="flex items-center gap-1.5">
          <label htmlFor="tip-custom" className="sr-only">
            Custom amount in Australian dollars
          </label>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">$</span>
          <input
            id="tip-custom"
            type="number"
            inputMode="decimal"
            min={MIN_DOLLARS}
            max={MAX_DOLLARS}
            placeholder="Your call"
            value={custom}
            disabled={busy}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
            }}
            className="w-24 rounded-md border border-zinc-300 px-2 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="button"
            disabled={busy || custom.trim() === ""}
            onClick={submitCustom}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 transition-colors hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:border-indigo-500/60 dark:hover:bg-indigo-950/40"
          >
            {busy ? "Heading to Stripe…" : "Shout"}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
