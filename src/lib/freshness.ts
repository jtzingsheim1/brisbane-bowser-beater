import { unstable_cache } from "next/cache";
import { supabaseReadOnly } from "@/lib/supabase/server";

const DEFAULT_THRESHOLD_MINUTES = 60;
const CACHE_TTL_SECONDS = 60;

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

export async function getLatestIngestedAt(): Promise<Date | null> {
  const iso = await getCachedLatestIso();
  return iso ? new Date(iso) : null;
}

export async function getDataAgeMinutes(): Promise<number | null> {
  const latest = await getLatestIngestedAt();
  if (!latest) {
    return null;
  }
  return (Date.now() - latest.getTime()) / 60_000;
}

export async function isStale(
  thresholdMinutes: number = DEFAULT_THRESHOLD_MINUTES,
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
