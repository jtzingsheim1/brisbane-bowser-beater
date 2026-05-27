import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Where this data comes from — Brisbane Bowser Beater",
  description:
    "Attribution and sourcing for the fuel price data used by Brisbane Bowser Beater.",
};

// Render per-request so the verbatim attribution notices always carry the
// current year (LUL 4.2/4.3), not the build-time year.
export const dynamic = "force-dynamic";

export default function AboutDataPage() {
  const year = new Date().getFullYear();

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16 text-zinc-800 dark:text-zinc-200">
      <Link
        href="/"
        className="text-sm text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        &larr; Back to the chart
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Where this data comes from
      </h1>

      <div className="mt-8 space-y-4 text-base leading-7">
        <p>
          Live retail fuel prices on this site are polled every 30 minutes from
          the{" "}
          <a
            href="https://www.fuelpricesqld.com.au/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-950 underline dark:text-zinc-50"
          >
            QLD Fuel Price Reporting
          </a>{" "}
          API &mdash; Queensland&rsquo;s mandatory fuel-price reporting scheme.
          We are a registered publisher under that program.
        </p>
        <p>
          The historical background on the chart comes from the Queensland
          government&rsquo;s open-data CSV (&ldquo;Fuel Price Reporting
          2026&rdquo;), published under a Creative Commons Attribution 4.0
          licence at{" "}
          <a
            href="https://data.qld.gov.au/dataset/fuel-price-reporting-2026"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-950 underline dark:text-zinc-50"
          >
            data.qld.gov.au/dataset/fuel-price-reporting-2026
          </a>
          .
        </p>
        <p>
          We display the Brisbane area average only. We don&rsquo;t currently
          show per-station prices on this site.
        </p>
      </div>

      <h2 className="mt-12 text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Attribution &mdash; QLD Fuel Price Data Licence
      </h2>

      <blockquote className="mt-4 border-l-4 border-zinc-300 pl-4 text-base leading-7 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
        © State of Queensland (Department of Energy and Climate) {year}. In
        consideration of the State permitting use of this data you acknowledge
        and agree that the State gives no warranty in relation to the data
        (including accuracy, reliability, completeness, currency or
        suitability) and accepts no liability (including without limitation,
        liability in negligence) for any loss, damage or costs (including
        consequential damage) relating to any use of the data. Data must not be
        used for direct marketing or be used in breach of the privacy laws.
      </blockquote>

      <blockquote className="mt-4 border-l-4 border-zinc-300 pl-4 text-base leading-7 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
        Based on or contains data provided by the State of Queensland
        (Department of Energy and Climate) {year}. In consideration of the
        State permitting use of this data you acknowledge and agree that the
        State gives no warranty in relation to the data (including accuracy,
        reliability, completeness, currency or suitability) and accepts no
        liability (including without limitation, liability in negligence) for
        any loss, damage or costs (including consequential damage) relating to
        any use of the data. Data must not be used for direct marketing or be
        used in breach of the privacy laws.
      </blockquote>

      <h2 className="mt-12 text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Attribution &mdash; open-data historical CSV
      </h2>

      <blockquote className="mt-4 border-l-4 border-zinc-300 pl-4 text-base leading-7 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
        Historical price data: &ldquo;Fuel Price Reporting 2026&rdquo; by the
        State of Queensland (Department of Energy and Climate), used under{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-950 underline dark:text-zinc-50"
        >
          Creative Commons Attribution 4.0
        </a>
        . Sourced from{" "}
        <a
          href="https://data.qld.gov.au/dataset/fuel-price-reporting-2026"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-950 underline dark:text-zinc-50"
        >
          data.qld.gov.au/dataset/fuel-price-reporting-2026
        </a>
        .
      </blockquote>
    </main>
  );
}
