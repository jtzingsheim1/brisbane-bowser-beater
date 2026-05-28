import { unstable_cache } from "next/cache";
import { supabaseReadOnly } from "@/lib/supabase/server";

const FALLBACK_THRESHOLD_MINUTES = 60;
const MAX_THRESHOLD_MINUTES = 1440; // 24 h — beyond this, "stale" is meaningless
const CACHE_TTL_SECONDS = 60;

// Staleness threshold in minutes, tunable via the BBB_STALENESS_MINUTES env var
// so it can be right-sized (or effectively relaxed) from the Vercel dashboard
// without a code change. Rationale: the public chart shows a *daily* aggregate
// average, so a few hours of intraday lag — e.g. from GitHub Actions cron
// delays — doesn't materially change what's displayed; the 60-minute default
// was sized for live per-station prices we don't actually show. Set it high to
// ride out scheduler lag. Falls back to 60 when unset or invalid; clamped to
// MAX_THRESHOLD_MINUTES to prevent footguns (a pathological value like 1e308
// would silently disable the gate entirely, contradicting LUL 2.3 intent).
function configuredThresholdMinutes(): number {
  const raw = Number(process.env.BBB_STALENESS_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return FALLBACK_THRESHOLD_MINUTES;
  return Math.min(raw, MAX_THRESHOLD_MINUTES);
}

async function fetchLatestIngestedAt(): Promise<Date | null> {
  const client = supabaseReadOnly();
  const { data, error } = await client
    .from("price_snapshots")
    .select("ingested_at")
    .order("ingested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data?.ingested_at) {
    return null;
  }
  return new Date(data.ingested_at as string);
}

// Cached across requests for CACHE_TTL_SECONDS so a burst of page renders
// doesn't translate to a burst of Supabase queries. Errors are not cached —
// throws propagate and the next request will re-attempt.
const getCachedLatestIso = unstable_cache(
  async (): Promise<string | null> => {
    const date = await fetchLatestIngestedAt();
    return date ? date.toISOString() : null;
  },
  ["freshness:latest-ingested-at"],
  { revalidate: CACHE_TTL_SECONDS },
);

async function getLatestIngestedAt(): Promise<Date | null> {
  const iso = await getCachedLatestIso();
  return iso ? new Date(iso) : null;
}

async function getDataAgeMinutes(): Promise<number | null> {
  const latest = await getLatestIngestedAt();
  if (!latest) {
    return null;
  }
  return (Date.now() - latest.getTime()) / 60_000;
}

export async function isStale(
  thresholdMinutes: number = configuredThresholdMinutes(),
): Promise<boolean> {
  const ageMinutes = await getDataAgeMinutes();
  if (ageMinutes === null) {
    return true;
  }
  return ageMinutes > thresholdMinutes;
}

export function isKillSwitchEngaged(): boolean {
  const raw = process.env.BBB_PUBLIC;
  if (raw == null || raw === "") {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "false" || normalized === "0";
}
