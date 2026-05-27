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
  const { data, error } = await client
    .from("price_snapshots")
    .select("transaction_date_utc")
    .eq("fuel_name", "Unleaded")
    .order("transaction_date_utc", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data?.transaction_date_utc) {
    return null;
  }
  return new Date(data.transaction_date_utc as string);
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
  const { data, error } = await client
    .from("price_snapshots")
    .select("transaction_date_utc")
    .eq("fuel_name", "Unleaded")
    .eq("data_source", source)
    .order("transaction_date_utc", { ascending })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data?.transaction_date_utc
    ? toIsoDate(new Date(data.transaction_date_utc as string))
    : null;
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
async function liveCoverageRampEnd(): Promise<string | null> {
  const client = supabaseReadOnly();
  const { count: coreCount, error: coreError } = await client
    .from("sites")
    .select("*", { count: "exact", head: true })
    .eq("state", "QLD")
    .gte("postcode", "4000")
    .lte("postcode", "4179");
  if (coreError) {
    throw coreError;
  }
  if (!coreCount) {
    return null;
  }

  const { data: live, error } = await client
    .from("price_snapshots")
    .select("site_id, transaction_date_utc")
    .eq("fuel_name", "Unleaded")
    .eq("data_source", "live_api")
    .order("transaction_date_utc", { ascending: true });
  if (error) {
    throw error;
  }
  if (!live || live.length === 0) {
    return null;
  }

  const needed = coreCount * LIVE_COVERAGE_THRESHOLD;
  const seen = new Set<unknown>();
  for (const row of live) {
    seen.add(row.site_id);
    if (seen.size >= needed) {
      // First day coverage is adequate → trustworthy data starts here, so the
      // ramp (no-data) ends the day before.
      return addUtcDays(
        toIsoDate(new Date(row.transaction_date_utc as string)),
        -1,
      );
    }
  }
  // Threshold never reached: no day is trustworthy yet — extend through the
  // most recent live day.
  return toIsoDate(
    new Date(live[live.length - 1].transaction_date_utc as string),
  );
}

// The "deadzone" is the span of days we can't show a trustworthy Brisbane
// average for. It has two parts: (1) the calendar gap between the end of the
// CC BY backfill and the start of live ingestion (no data at all — the RPC
// forward-fills it), and (2) the live ramp-up, during which too few stations
// have reported live prices so the average is dominated by stale carry-forward.
// The chart masks this span rather than drawing a misleading flat line. Returns
// null once live coverage is healthy and has caught up to the backfill.
async function fetchCoverageDeadzone(): Promise<Deadzone | null> {
  const lastBackfillDay = await latestDayForSource("csv_backfill", false);
  const firstLiveDay = await latestDayForSource("live_api", true);
  if (!lastBackfillDay || !firstLiveDay) {
    return null;
  }

  let end = addUtcDays(firstLiveDay, -1);
  const rampEnd = await liveCoverageRampEnd();
  if (rampEnd && rampEnd > end) {
    end = rampEnd;
  }

  const start = addUtcDays(lastBackfillDay, 1);
  return start <= end ? { start, end } : null;
}

const getCachedCoverageDeadzone = unstable_cache(
  fetchCoverageDeadzone,
  // Versioned cache key — bump when the deadzone logic changes so dev/prod don't
  // serve a stale span from the old computation.
  ["aggregates:coverage-deadzone:v2"],
  { revalidate: CACHE_TTL_SECONDS },
);

export async function getCoverageDeadzone(): Promise<Deadzone | null> {
  return getCachedCoverageDeadzone();
}
