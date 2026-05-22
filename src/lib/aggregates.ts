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

export async function getBrisbaneDailyU91History(
  days: number = 60,
): Promise<DailyPoint[]> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return getCachedDailyU91(toIsoDate(start), toIsoDate(end));
}

async function fetchLatestForecast(): Promise<ForecastPoint[]> {
  const client = supabaseReadOnly();
  const { data: generated, error: genError } = await client
    .from("forecasts")
    .select("generated_at")
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
