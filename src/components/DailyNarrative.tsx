import { unstable_cache } from "next/cache";
import { supabaseReadOnly } from "@/lib/supabase/server";

const CACHE_TTL_SECONDS = 60 * 60;

// Matches the grain written by the daily generator (see migration 0008).
const NARRATIVE_FUEL_NAME = "Unleaded";
const NARRATIVE_REGION = "brisbane_metro";

const FALLBACK_NARRATIVE =
  "Brisbane prices move in recurring cycles. The chart shows where they're sitting now and where the forecast has them heading.";

async function fetchTodayNarrative(): Promise<string | null> {
  const client = supabaseReadOnly();
  const { data, error } = await client
    .from("daily_narrative")
    .select("narrative_text, narrative_date")
    .eq("fuel_name", NARRATIVE_FUEL_NAME)
    .eq("region", NARRATIVE_REGION)
    .order("narrative_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data?.narrative_text ?? null;
}

const getCachedNarrative = unstable_cache(
  fetchTodayNarrative,
  ["narrative:latest"],
  { revalidate: CACHE_TTL_SECONDS },
);

export default async function DailyNarrative() {
  let text: string;
  try {
    text = (await getCachedNarrative()) ?? FALLBACK_NARRATIVE;
  } catch (error) {
    console.error("[narrative] fetch failed; using fallback", error);
    text = FALLBACK_NARRATIVE;
  }

  return (
    <p
      aria-label="Today's Brisbane fuel cycle summary"
      className="text-base leading-7 text-zinc-800 dark:text-zinc-200"
    >
      {text}
    </p>
  );
}
