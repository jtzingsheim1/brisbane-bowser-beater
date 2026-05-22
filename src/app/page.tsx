import AgentChat from "@/components/AgentChat";
import CycleEducation from "@/components/CycleEducation";
import DailyNarrative from "@/components/DailyNarrative";
import PriceChart from "@/components/PriceChart";
import PrivacyTrustPane from "@/components/PrivacyTrustPane";
import {
  getBrisbaneDailyU91History,
  getLatestForecast,
} from "@/lib/aggregates";

export default async function Home() {
  const [history, forecast] = await Promise.all([
    getBrisbaneDailyU91History(60),
    getLatestForecast(),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 sm:px-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-4xl">
          When to fill up
        </h1>
        <p className="mt-2 text-base text-zinc-600 dark:text-zinc-400">
          Brisbane area U91 daily average. Past two months observed, plus a
          forward-looking forecast when one&rsquo;s available.
        </p>
      </header>

      <section aria-label="Brisbane U91 price chart" className="mb-6">
        <PriceChart history={history} forecast={forecast} />
      </section>

      <section className="mb-10">
        <DailyNarrative />
      </section>

      <section className="mb-10">
        <CycleEducation />
      </section>

      <section aria-label="Fuel strategist planner" className="mb-10">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Personal fuel strategy planner
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Describe your situation and the planner will turn the cycle into a
          fill-day plan.
        </p>
        <div className="mt-4">
          <PrivacyTrustPane />
        </div>
        <div className="mt-4">
          <AgentChat />
        </div>
      </section>
    </main>
  );
}
