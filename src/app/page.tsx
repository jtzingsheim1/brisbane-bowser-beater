import AgentChat from "@/components/AgentChat";
import CycleEducation from "@/components/CycleEducation";
import DailyNarrative from "@/components/DailyNarrative";
import Disclosure from "@/components/Disclosure";
import PriceChart from "@/components/PriceChart";
import PrivacyTrustPane from "@/components/PrivacyTrustPane";
import TipJar from "@/components/TipJar";
import { headers } from "next/headers";
import { after } from "next/server";
import {
  getBrisbaneDailyU91History,
  getCoverageDeadzones,
  getLatestForecast,
} from "@/lib/aggregates";
import { tipsEnabled } from "@/lib/tips/config";
import { recordVisit } from "@/lib/usage";

export default async function Home() {
  // LUL 4.8 aggregate usage counting — headers captured during render, the
  // count recorded post-response (best-effort, no PII; see src/lib/usage.ts).
  const requestHeaders = await headers();
  after(() => recordVisit(requestHeaders));

  const [history, forecast, deadzones] = await Promise.all([
    getBrisbaneDailyU91History(60),
    getLatestForecast(),
    getCoverageDeadzones(),
  ]);

  // Show the deadzone explainer only while at least one no-data band is actually
  // on the chart — i.e. a gap still intersects the visible window. As live data
  // accumulates and the window slides past a gap, its band (and eventually this
  // note) disappear with no manual cleanup.
  const deadzoneVisible = deadzones.some((d) =>
    history.some((h) => h.day >= d.start && h.day <= d.end),
  );

  // Trustworthy observed days = those after the *last* deadzone, i.e. genuinely
  // recent live data — not the April backfill island that sits between the
  // missing-month gap and the live ramp-up. While that's thin, the forecast is
  // fit on little real recent history, so we flag it preliminary. Auto-clears
  // once ~2 weeks of live data accrue past the final gap.
  const lastDeadzoneEnd = deadzones.reduce<string | null>(
    (max, d) => (max === null || d.end > max ? d.end : max),
    null,
  );
  const TRUSTED_DAYS_FOR_CONFIDENT_FORECAST = 14;
  const trustedObservedDays =
    lastDeadzoneEnd !== null
      ? history.filter((h) => h.day > lastDeadzoneEnd).length
      : history.length;
  const forecastPreliminary =
    forecast.length > 0 &&
    trustedObservedDays < TRUSTED_DAYS_FOR_CONFIDENT_FORECAST;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-3xl">
          When to fill up
        </h1>
        <p className="mt-2 text-base text-zinc-600 dark:text-zinc-400">
          Brisbane area U91 daily average. Past two months observed, plus a
          forward-looking forecast.
        </p>
      </header>

      <section aria-label="Brisbane U91 price chart" className="mb-6">
        <PriceChart
          history={history}
          forecast={forecast}
          deadzones={deadzones}
        />
      </section>

      <section className="mb-10">
        <DailyNarrative />
        <div className="mt-3 space-y-1.5">
          <CycleEducation />
          {deadzoneVisible && (
            <Disclosure summary="About the shaded gap">
              We only chart a Brisbane average we can stand behind &mdash; and
              even with two sources, one gap remains. Our primary, ongoing
              source is the QLD Fuel Price Reporting API: we received our access
              token in late May and began ingesting straight away, so by late
              July the
              whole 60-day window should be live API data. To show a full
              history in the meantime, we backfilled the earlier stretch with the
              same QLD open-data history we used to build the forecast model
              &mdash; but that source hasn&rsquo;t published May yet, which is
              the shaded gap. It closes as the live history fills in.
            </Disclosure>
          )}
          {forecastPreliminary && (
            <Disclosure summary="Forecast is preliminary">
              We only began collecting live Brisbane prices in May, so it&rsquo;s
              working from limited recent history and will sharpen as more
              accumulates. Recent disruption across fuel markets has also
              unsettled the long-standing price cycle the model is built on
              &mdash; and when that underlying rhythm shifts, a model trained on
              past cycles can&rsquo;t fully keep pace with it. For the next few
              weeks especially, treat the forecast as an early estimate, not a
              firm projection.
            </Disclosure>
          )}
        </div>
      </section>

      <section aria-label="AI fuel strategy agent" className="mb-10">
        <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          AI fuel strategy agent
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Describe your situation and the AI agent builds your fill-day plan.
          No account, no tracking, anonymous caching.
        </p>
        <div className="mt-1">
          <PrivacyTrustPane />
        </div>
        <div className="mt-4">
          <AgentChat />
        </div>
      </section>

      {/* Flag-gated (BBB_TIPS): no payment UI renders until live Stripe keys
          and the webhook are wired up. */}
      {tipsEnabled() && (
        <section aria-label="Support the developer" className="mb-4">
          <TipJar />
        </section>
      )}
    </main>
  );
}
