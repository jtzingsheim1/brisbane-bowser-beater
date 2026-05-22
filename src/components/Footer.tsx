export default function Footer() {
  return (
    <footer className="border-t border-zinc-200 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 sm:flex-row sm:justify-between sm:gap-6">
        <p className="text-center sm:text-left">
          General information only. Fuel prices and forecasts are estimates
          &mdash; verify before you fill.
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <a
            href="/about/data"
            className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Where this data comes from
          </a>
          <a
            href="https://github.com/jtzingsheim1/brisbane-bowser-beater"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Source on GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
