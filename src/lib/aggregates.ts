import { unstable_cache } from "next/cache";
import { supabaseReadOnly } from "@/lib/supabase/server";

const CACHE_TTL_SECONDS = 60 * 60;

export type DailyPoint = {
  day: string;
  avgPrice: number;
  stationCount: number;
};

export type ForecastPoint = {
  day: string;
  predictedPrice: number;
  bandLow: number | null;
  bandHigh: number | null;
};

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchDailyU91(
  startDate: string,
  endDate: string,
): Promise<DailyPoint[]> {
  const client = supabaseReadOnly();
  const { data, error } = await client.rpc("brisbane_daily_avg_u91", {
    start_date: startDate,
    end_date: endDate,
  });

  if (error) {
    throw error;
  }

  return (data ?? []).map(
    (row: { day: string; avg_price: number; station_count: number }) => ({
      day: row.day,
      avgPrice: Number(row.avg_price),
      stationCount: row.station_count,
    }),
  );
}

const getCachedDailyU91 = unstable_cache(
  fetchDailyU91,
  ["aggregates:brisbane-daily-u91"],
  { revalidate: CACHE_TTL_SECONDS },
);

async function fetchLatestEventDate(): Promise<Date | null> {
  const client = supabaseReadOnly();
  // Security-definer RPC (migration 0013) — no direct price_snapshots read.
  const { data, error } = await client.rpc("snapshot_event_bound", {
    p_fuel_name: "Unleaded",
    p_source: null,
    p_earliest: false,
  });

  if (error) {
    throw error;
  }
  return data ? new Date(data as string) : null;
}

const getCachedLatestEventIso = unstable_cache(
  async (): Promise<string | null> => {
    const d = await fetchLatestEventDate();
    return d ? d.toISOString() : null;
  },
  ["aggregates:latest-event-date"],
  { revalidate: CACHE_TTL_SECONDS },
);

// Anchors the chart window to the most recent real event rather than `now()`.
// While we're between backfill and live-cron data, the latest event is from
// Feb 2026 — without this, the chart would carry-forward a flat line for
// weeks. Once the live cron starts, latest-event is ~now and behaviour
// reverts to the natural "last N days from today" window.
export async function getBrisbaneDailyU91History(
  days: number = 60,
): Promise<DailyPoint[]> {
  const latestIso = await getCachedLatestEventIso();
  const end = latestIso ? new Date(latestIso) : new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return getCachedDailyU91(toIsoDate(start), toIsoDate(end));
}

// The forecast grain written by the cron (see migration 0007). MVP is one fuel,
// one region; filtering keeps the "latest batch" lookup correct if that grows.
const FORECAST_FUEL_NAME = "Unleaded";
const FORECAST_REGION = "brisbane_metro";

async function fetchLatestForecast(): Promise<ForecastPoint[]> {
  const client = supabaseReadOnly();
  const { data: generated, error: genError } = await client
    .from("forecasts")
    .select("generated_at")
    .eq("fuel_name", FORECAST_FUEL_NAME)
    .eq("region", FORECAST_REGION)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (genError) {
    throw genError;
  }
  if (!generated?.generated_at) {
    return [];
  }

  const { data, error } = await client
    .from("forecasts")
    .select("forecast_for_date, predicted_price, band_low, band_high")
    .eq("fuel_name", FORECAST_FUEL_NAME)
    .eq("region", FORECAST_REGION)
    .eq("generated_at", generated.generated_at)
    .order("forecast_for_date", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(
    (row: {
      forecast_for_date: string;
      predicted_price: number;
      band_low: number | null;
      band_high: number | null;
    }) => ({
      day: row.forecast_for_date,
      predictedPrice: Number(row.predicted_price),
      bandLow: row.band_low === null ? null : Number(row.band_low),
      bandHigh: row.band_high === null ? null : Number(row.band_high),
    }),
  );
}

const getCachedLatestForecast = unstable_cache(
  fetchLatestForecast,
  ["aggregates:latest-forecast"],
  { revalidate: CACHE_TTL_SECONDS },
);

export async function getLatestForecast(): Promise<ForecastPoint[]> {
  return getCachedLatestForecast();
}

export type Deadzone = { start: string; end: string };

function addUtcDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return toIsoDate(d);
}

async function latestDayForSource(
  source: "csv_backfill" | "live_api",
  ascending: boolean,
): Promise<string | null> {
  const client = supabaseReadOnly();
  // Security-definer RPC (migration 0013): ascending=true means "earliest".
  const { data, error } = await client.rpc("snapshot_event_bound", {
    p_fuel_name: "Unleaded",
    p_source: source,
    p_earliest: ascending,
  });

  if (error) {
    throw error;
  }
  return data ? toIsoDate(new Date(data as string)) : null;
}

// Fraction of core stations that must have reported a live price before a day's
// average is trusted. Below this, the daily average is dominated by stale
// carry-forward (most stations still on their pre-live value), so we treat the
// day as no-data. NOTE: this is the ramp-up heuristic (option A). The deeper fix
// (option B — staleness-cap carry-forward per station, so dormant/closed
// stations age out) is tracked in PLAN.md and would supersede this.
const LIVE_COVERAGE_THRESHOLD = 0.8;

// The last day before live coverage crosses LIVE_COVERAGE_THRESHOLD — i.e. the
// end of the "live ramp-up" during which the average can't be trusted. Returns
// null if there's no live data; returns the latest live day if coverage has
// never yet crossed the threshold (nothing trustworthy yet).
//
// Computed in SQL (security-definer RPC, migration 0013) since 2026-08: the
// old implementation fetched every live per-station row into Node and walked
// it — the parked "growth cliff" audit item — and needed anon table grants
// that the aggregate-only posture is retiring. Same semantics, one date out.
async function liveCoverageRampEnd(): Promise<string | null> {
  const client = supabaseReadOnly();
  const { data, error } = await client.rpc("live_coverage_ramp_end", {
    p_fuel_name: "Unleaded",
    p_threshold: LIVE_COVERAGE_THRESHOLD,
  });
  if (error) {
    throw error;
  }
  // PostgREST serialises the date as "YYYY-MM-DD", already our day format.
  return (data as string | null) ?? null;
}

// A "deadzone" is a span of days we can't show a trustworthy Brisbane average
// for. There can be more than one, because backfill coverage isn't always
// contiguous: e.g. QLD publishes its monthly open-data CSVs out of order, so a
// month in the middle of our history can be missing entirely while later months
// are present. Sources of deadzone:
//   (1) Internal data gaps — a stretch with no events at all (a month QLD
//       hasn't published, or a cron outage). The carry-forward RPC fills these
//       with a dead-flat line, so we detect them as flat runs in the series
//       (the same carry-forward signature trimDeadZone keys on in project.ts).
//   (2) The backfill→live transition: the calendar gap between the last
//       backfill day and the first live day, extended through the live ramp-up
//       during which too few stations have reported for the average to be
//       trusted (see liveCoverageRampEnd).
// We compute both, then merge overlapping/adjacent spans. The chart masks each
// span rather than drawing a misleading flat line across it.

// How far back to scan for internal gaps. Comfortably wider than the chart's
// ~60-day window so a gap's full flat run is visible (and thus detectable) even
// when only its tail edge falls inside the rendered window.
const DEADZONE_SCAN_DAYS = 120;
// A run of this many days whose average doesn't move (within FLAT_EPS) is
// carry-forward, not real data. A cross-station average never sits this flat
// for real, so a flat run is an unambiguous "no data here" signal.
const FLAT_RUN_DAYS = 5;
const FLAT_EPS = 0.001; // $/L — matches project.ts; daily moves under 0.1c

// Maximal flat runs (carry-forward gaps) in an ascending daily series.
function detectFlatRuns(series: DailyPoint[]): Deadzone[] {
  const spans: Deadzone[] = [];
  let runStart = 0;
  const flush = (endIdx: number) => {
    if (endIdx - runStart + 1 >= FLAT_RUN_DAYS) {
      spans.push({ start: series[runStart].day, end: series[endIdx].day });
    }
  };
  for (let i = 1; i < series.length; i++) {
    if (Math.abs(series[i].avgPrice - series[i - 1].avgPrice) > FLAT_EPS) {
      flush(i - 1);
      runStart = i;
    }
  }
  if (series.length > 0) flush(series.length - 1);
  return spans;
}

// Merge overlapping or day-adjacent spans into a minimal sorted set.
function mergeSpans(spans: Deadzone[]): Deadzone[] {
  const sorted = [...spans].sort((a, b) => (a.start < b.start ? -1 : 1));
  const merged: Deadzone[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent (last.end + 1 day === s.start) counts as overlapping so two
    // touching gaps render as one box.
    if (last && s.start <= addUtcDays(last.end, 1)) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

async function fetchCoverageDeadzones(): Promise<Deadzone[]> {
  const lastBackfillDay = await latestDayForSource("csv_backfill", false);
  if (!lastBackfillDay) {
    return [];
  }

  const spans: Deadzone[] = [];

  // (2) Backfill→live transition + ramp.
  //
  // Only extend `end` past the calendar transition via `rampEnd` when there's
  // an actual calendar gap between CSV and live. If CSV bridges right up to
  // live's first day (the post-#47 seam-cutover case), CSV-side carry-forward
  // is what fills the early-ramp days where the live feed alone would be too
  // thin — so no deadzone band is honest. Without this guard, the cutover
  // delete in scripts/backfill-csv.mjs would leave a permanent 4-ish day band
  // (liveCoverageRampEnd looks at cumulative-distinct live sites, which
  // restarts from scratch after the delete and takes days to re-cross 80%).
  const firstLiveDay = await latestDayForSource("live_api", true);
  if (firstLiveDay) {
    let end = addUtcDays(firstLiveDay, -1);
    const calendarGap = firstLiveDay > addUtcDays(lastBackfillDay, 1);
    if (calendarGap) {
      const rampEnd = await liveCoverageRampEnd();
      if (rampEnd && rampEnd > end) {
        end = rampEnd;
      }
    }
    const start = addUtcDays(lastBackfillDay, 1);
    if (start <= end) {
      spans.push({ start, end });
    }
  }

  // (1) Internal flat-run gaps, scanned over a window wide enough to catch a
  // gap's full run even when the chart only shows its edge.
  const latestIso = await getCachedLatestEventIso();
  const scanEnd = latestIso ? toIsoDate(new Date(latestIso)) : null;
  if (scanEnd) {
    const scanStart = addUtcDays(scanEnd, -DEADZONE_SCAN_DAYS);
    const series = await getCachedDailyU91(scanStart, scanEnd);
    spans.push(...detectFlatRuns(series));
  }

  return mergeSpans(spans);
}

const getCachedCoverageDeadzones = unstable_cache(
  fetchCoverageDeadzones,
  // Versioned cache key — bump when the deadzone logic changes so dev/prod don't
  // serve stale spans from the old computation. v4 = #47 seam-cutover (rampEnd
  // extension gated on calendar gap; v3 = multi-span + flat-run).
  ["aggregates:coverage-deadzone:v4"],
  { revalidate: CACHE_TTL_SECONDS },
);

export async function getCoverageDeadzones(): Promise<Deadzone[]> {
  return getCachedCoverageDeadzones();
}
