// Subtle inline disclosure used for the small "learn more" notes under the
// chart (the shaded-gap explainer, the preliminary-forecast caveat, and the
// cycle explainer). Native <details>, so no client JS and keyboard-accessible.
// Kept visually quiet on purpose — these sit below the headline narrative and
// must not compete with the planner section for attention.
export default function Disclosure({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline [&::-webkit-details-marker]:hidden dark:text-zinc-400 dark:hover:text-zinc-200">
        <span
          aria-hidden="true"
          className="transition-transform group-open:rotate-90"
        >
          &rsaquo;
        </span>
        {summary}
      </summary>
      <div className="mt-2 text-sm italic leading-6 text-zinc-500 dark:text-zinc-400">
        {children}
      </div>
    </details>
  );
}
