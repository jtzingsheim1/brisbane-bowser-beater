import Link from "next/link";
import CycleHistoryChart from "./CycleHistoryChart";
import CycleShapeChart from "./CycleShapeChart";
import { cycleShapesArtifact, historyArtifact } from "@/lib/history/artifacts";

// The always-visible "show, don't tell" band: three years of history proves
// the cycle exists; the overlay shows the model that forecasts it. Kept
// compact and muted so it reads as context under the main chart without
// competing with the planner section below. Captions are observation-only
// per the project's language discipline.

function monthYear(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "Australia/Brisbane",
  });
}

export default function CycleVisuals() {
  const h = historyArtifact.source;
  const s = cycleShapesArtifact.source;

  return (
    <section aria-label="Three years of Brisbane price cycles">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        The cycle, at a glance
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Brisbane fuel prices move in recurring cycles. Three years of data
        makes the pattern hard to miss &mdash; and it&rsquo;s what this
        site&rsquo;s forecast is built on.
      </p>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <figure>
          <CycleHistoryChart />
          <figcaption className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Brisbane average U91, {monthYear(h.span_start)} &ndash;{" "}
            {monthYear(h.span_end)}. Shaded: an unusual stretch excluded from
            cycle fitting. Dashed line: end of the currently fitted window.
          </figcaption>
        </figure>
        <figure>
          <CycleShapeChart />
          <figcaption className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
            Every regular cycle from those three years, overlaid from one
            cheapest day to the next (a few irregular stretches excluded). The
            bold line is the recency-weighted average shape &mdash; the
            template our forecast projects forward.
          </figcaption>
        </figure>
      </div>
      <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
        {`${s.n_cycles} cycles fitted.`} Data: QLD Fuel Price Reporting,
        data.qld.gov.au (CC BY 4.0) &mdash;{" "}
        <Link
          href="/about/data"
          className="underline underline-offset-2 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          about the data
        </Link>
        .
      </p>
    </section>
  );
}
