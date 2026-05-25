export default function CycleEducation() {
  return (
    <section
      aria-label="About the Brisbane fuel cycle"
      className="text-base leading-7 text-zinc-700 dark:text-zinc-300"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Why timing matters
      </h2>
      <div className="mt-3 space-y-3">
        <p>
          Brisbane retail fuel prices move in recurring cycles &mdash; a
          pattern seen across other Australian capital cities too. The cycle is
          not closely correlated with wholesale price movements, so where you
          sit in the cycle on any given day tends to matter more than what&rsquo;s
          happening to the underlying cost of fuel. Pricing decisions drive
          the within-cycle variation.
        </p>
        <p>
          On recent form the cycle runs roughly 39 days and swings about 35c a
          litre between trough and peak, with prices tending to climb to the
          peak faster than they ease back down. Those are estimates from the
          historical price series rather than promises &mdash; but they&rsquo;re
          why the cycle is worth planning around. Timing your fills with it,
          instead of refuelling whenever the gauge gets low, is where the
          saving comes from.
        </p>
        <p>
          The ACCC publishes regular{" "}
          <a
            href="https://www.accc.gov.au/by-industry/petrol-and-fuel/fuel-and-petrol-monitoring"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-950 underline dark:text-zinc-50"
          >
            fuel and petrol monitoring reports
          </a>{" "}
          describing the pattern. This tool&rsquo;s job is simpler: show you
          where the cycle is right now, so you can time your next fill
          accordingly.
        </p>
      </div>
    </section>
  );
}
