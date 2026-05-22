import { unstable_cache } from "next/cache";
import { supabaseReadOnly } from "@/lib/supabase/server";

const CACHE_TTL_SECONDS = 60 * 60;

const FALLBACK_NARRATIVE =
  "Brisbane prices move in recurring cycles. The chart shows the current shape — daily narrative will land once the forecast model is in.";

async function fetchTodayNarrative(): Promise<string | null> {
  const client = supabaseReadOnly();
  const { data, error } = await client
    .from("daily_narrative")
    .select("narrative_text, narrative_date")
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
