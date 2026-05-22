export default function PrivacyTrustPane() {
  return (
    <aside
      aria-label="Privacy and trust notes"
      className="rounded-lg border border-zinc-200 bg-zinc-50 px-5 py-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
    >
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        Before you ask the planner
      </h2>
      <ul className="mt-3 space-y-2 leading-6">
        <li>No account, no login. Nothing here is tied to who you are.</li>
        <li>
          We don&rsquo;t store your conversation. It goes to Anthropic to
          generate your plan, then it&rsquo;s gone on our side. (Anthropic&rsquo;s
          terms apply to their bit.)
        </li>
        <li>No tracking, no analytics, no cookies that follow you around.</li>
        <li>
          Caching is anonymous. Same situation gets the same plan &mdash; we
          hash the inputs, we don&rsquo;t keep them.
        </li>
        <li>
          Only the planner is AI. The station ranking and forecast chart are
          deterministic.
        </li>
        <li>
          It&rsquo;s all on GitHub. Don&rsquo;t trust this list? Read the code.
        </li>
      </ul>
    </aside>
  );
}
