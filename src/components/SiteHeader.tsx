import Link from "next/link";

export default function SiteHeader() {
  return (
    <header className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
      <div className="mx-auto flex w-full max-w-3xl items-baseline gap-3">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-zinc-900 hover:text-zinc-600 dark:text-zinc-100 dark:hover:text-zinc-300"
        >
          Brisbane Bowser Beater
        </Link>
        <span className="hidden text-sm text-zinc-500 dark:text-zinc-400 sm:inline">
          Time your Brisbane fuel fills with the cycle
        </span>
      </div>
    </header>
  );
}
