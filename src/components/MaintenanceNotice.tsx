export default function MaintenanceNotice() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-16 text-center text-zinc-800 dark:text-zinc-200">
      <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Data temporarily unavailable
      </h1>
      <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
        We&rsquo;re refreshing or paused. Try again in a few minutes.
      </p>
      <a
        href="https://github.com/jtzingsheim1/brisbane-bowser-beater"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 text-sm font-medium text-zinc-950 underline dark:text-zinc-50"
      >
        Source on GitHub
      </a>
    </main>
  );
}
