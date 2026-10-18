import Disclosure from "./Disclosure";

export default function PrivacyTrustPane() {
  return (
    <Disclosure summary="How this works & your privacy">
      <ul className="list-disc space-y-1 ps-5">
        <li>No account, no login, no name or email asked for.</li>
        <li>
          We don&rsquo;t store what you type. It goes to Anthropic to generate
          your plan, then it&rsquo;s gone on our side. (Anthropic&rsquo;s
          terms apply to their bit.)
        </li>
        <li>
          No third-party analytics and no cookies that follow you around. We
          count monthly visitors with a salted hash of your IP address, because
          our data licence asks for usage numbers.
        </li>
        <li>
          Caching is anonymous. Same situation gets the same plan &mdash; we
          keep the plan for up to 30 days under a hash of your inputs, never
          the inputs themselves.
        </li>
        <li>Only the agent is AI. The forecast chart is deterministic.</li>
        <li>
          It&rsquo;s all on GitHub. Don&rsquo;t trust this list?{" "}
          <a
            href="https://github.com/jtzingsheim1/brisbane-bowser-beater"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-700 underline dark:text-zinc-300"
          >
            Read the code.
          </a>
        </li>
      </ul>
    </Disclosure>
  );
}
