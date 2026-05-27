import AgentChat from "@/components/AgentChat";
import CycleEducation from "@/components/CycleEducation";
import DailyNarrative from "@/components/DailyNarrative";
import Disclosure from "@/components/Disclosure";
import PriceChart from "@/components/PriceChart";
import PrivacyTrustPane from "@/components/PrivacyTrustPane";
import { headers } from "next/headers";
import { after } from "next/server";
import {
  getBrisbaneDailyU91History,
  getCoverageDeadzone,
  getLatestForecast,
} from "@/lib/aggregates";
import { recordVisit } from "@/lib/usage";

export default async function Home() {
  // LUL 4.8 aggregate usage counting — headers captured during render, the
  // count recorded post-response (best-effort, no PII; see src/lib/usage.ts).
  const requestHeaders = await headers();
  after(() => recordVisit(requestHeaders));

  const [history, forecast, deadzone] = await Promise.all([
    getBrisbaneDailyU91History(60),
    getLatestForecast(),
    getCoverageDeadzone(),
  ]);

  // Show the deadzone explainer only while the no-data band is actually on the
  // chart — i.e. the gap still intersects the visible window. Once live data
  // accumulates and the window slides past the gap, both the band and this note
  // disappear together, with no manual cleanup.
  const deadzoneVisible =
    deadzone !== null &&
    history.some((h) => h.day >= deadzone.start && h.day <= deadzone.end);

  // Trustworthy observed days = those after the deadzone (post-ramp live data).
  // While that's thin, the forecast is fit on very little real history, so we
  // flag it as preliminary. Auto-clears once ~2 weeks of live data accrue.
  const TRUSTED_DAYS_FOR_CONFIDENT_FORECAST = 14;
  const trustedObservedDays =
    deadzone !== null
      ? history.filter((h) => h.day > deadzone.end).length
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
          forward-looking forecast when one&rsquo;s available.
        </p>
      </header>

      <section aria-label="Brisbane U91 price chart" className="mb-6">
        <PriceChart
          history={history}
          forecast={forecast}
          deadzone={deadzone}
        />
      </section>

      <section className="mb-10">
        <DailyNarrative />
        <div className="mt-3 space-y-1.5">
          <CycleEducation />
          {deadzoneVisible && (
            <Disclosure summary="About the shaded gap">
              Our historical data (a public open-data backfill) runs to late
              February, and our live QLD fuel API feed only reached broad
              station coverage in late May. Until enough stations are
              reporting, there isn&rsquo;t a reliable Brisbane-wide average to
              show &mdash; so rather than draw a misleading line, we leave that
              stretch blank. It fills in and slides off the chart as live data
              accumulates.
            </Disclosure>
          )}
          {forecastPreliminary && (
            <Disclosure summary="Forecast is preliminary">
              We only began collecting live Brisbane prices in May, so it&rsquo;s
              working from limited recent history and will sharpen as more
              accumulates. Treat it as an early estimate, not a firm projection.
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
    </main>
  );
}
