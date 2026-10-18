import Link from "next/link";
import type { Metadata } from "next";
import { connection } from "next/server";
import TipTerms from "@/components/TipTerms";
import { supportEmail } from "@/lib/support";
import { tipsEnabled } from "@/lib/tips/config";
import {
  AGENT_PLAN_RETENTION_DAYS,
  USAGE_RETENTION_MONTHS,
} from "@/lib/retention";

export const metadata: Metadata = {
  title: "Privacy — Brisbane Bowser Beater",
  description:
    "What Brisbane Bowser Beater keeps about visitors, what Stripe and Anthropic see, and for how long.",
};

// Every statement here is backed by code: retention periods come from
// src/lib/retention.ts, the visitor count from src/lib/usage.ts, the tip
// ledger whitelist from src/lib/tips/ledger.ts. Change them together.

const linkClass = "font-medium text-zinc-950 underline dark:text-zinc-50";
const h2Class =
  "mt-12 text-xl font-semibold tracking-tight text-black dark:text-zinc-50";

export default async function PrivacyPage() {
  // Read the support address per request, so a Vercel env change needs no
  // code change.
  await connection();
  const email = supportEmail();
  const tips = tipsEnabled();

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16 text-zinc-800 dark:text-zinc-200">
      <Link
        href="/"
        className="text-sm text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        &larr; Back to the chart
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Privacy
      </h1>

      <div className="mt-8 space-y-4 text-base leading-7">
        <p>
          No account, no login, no third-party analytics and no cookies that
          follow you around. Here is everything this site keeps, and what the
          services it uses can see.
        </p>
      </div>

      <h2 className={h2Class}>What this site keeps</h2>
      <ul className="mt-4 list-disc space-y-3 ps-5 text-base leading-7">
        <li>
          <strong>A monthly visitor count.</strong> Our fuel data licence asks
          for monthly usage numbers, so we record one row per visitor per
          month: a salted hash of your IP address and a coarse region (such as
          &ldquo;QLD&rdquo;). We never store the IP address itself. Rows are
          deleted after {USAGE_RETENTION_MONTHS} months, counting the current
          one.
        </li>
        <li>
          <strong>Rate limiting.</strong> To stop abuse, the AI planner and the
          tip jar count requests per IP address. Those counters expire within a
          few minutes.
        </li>
        <li>
          <strong>Cached plans.</strong> The planner caches each plan against
          a hash of the situation you described, not the words themselves, so
          the same situation gets the same plan. Cached plans are deleted after{" "}
          {AGENT_PLAN_RETENTION_DAYS} days.
        </li>
      </ul>

      <h2 className={h2Class}>What Anthropic sees</h2>
      <p className="mt-4 text-base leading-7">
        If you use the AI planner, your conversation goes to Anthropic to
        generate your plan. We don&rsquo;t store it.{" "}
        <a
          href="https://www.anthropic.com/legal/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          Anthropic&rsquo;s privacy policy
        </a>{" "}
        applies to their part.
      </p>

      {tips && (
        <>
          <h2 className={h2Class}>Tips and what Stripe sees</h2>
          <div className="mt-4 space-y-4 text-base leading-7">
            <p>
              Tips are paid on Stripe&rsquo;s hosted checkout, so your card details
              never reach this site. Stripe asks for your name and email, and we
              can see those in our Stripe account. This site&rsquo;s database
              doesn&rsquo;t store them: it keeps only Stripe&rsquo;s reference
              IDs, the amount, the currency, the status and the time of each
              payment.{" "}
              <a
                href="https://stripe.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Stripe&rsquo;s privacy policy
              </a>{" "}
              applies to their part.
            </p>
            {/* The refund contact is in the Contact section below. */}
            <TipTerms email={null} />
          </div>
        </>
      )}

      {email && (
        <>
          <h2 className={h2Class}>Contact</h2>
          <p className="mt-4 text-base leading-7">
            Questions about privacy, or a refund for a tip made by mistake:{" "}
            <a href={`mailto:${email}`} className={linkClass}>
              {email}
            </a>
            .
          </p>
        </>
      )}
    </main>
  );
}
