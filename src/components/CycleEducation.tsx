import Disclosure from "./Disclosure";

// The prose layer of the cycle education. The visual layer — the three-year
// history and the model overlay — lives in CycleVisuals, always visible; this
// disclosure carries the background reading for whoever wants it. The second
// paragraph used to assert the cycle's numbers in prose; the charts now show
// them, so it's down to one sentence of framing.

export default function CycleEducation() {
  return (
    <Disclosure summary="More on how the Brisbane cycle works">
      <div className="space-y-3">
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
          litre between trough and peak &mdash; estimates from the historical
          series (charted above), not promises. Timing your fills with it,
          instead of refuelling whenever the gauge gets low, is where the
          saving comes from.
        </p>
        <p>
          The ACCC publishes regular{" "}
          <a
            href="https://www.accc.gov.au/by-industry/petrol-and-fuel/fuel-and-petrol-monitoring"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-700 underline dark:text-zinc-300"
          >
            fuel and petrol monitoring reports
          </a>{" "}
          describing the pattern. This tool&rsquo;s job is simpler: show you
          where the cycle is right now, so you can time your next fill
          accordingly.
        </p>
      </div>
    </Disclosure>
  );
}
