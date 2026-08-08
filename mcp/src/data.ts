// Read-only data access for the MCP tools, over Supabase's PostgREST API with
// the project's publishable (anon) key. Deliberately plain fetch, no client
// library: the entire network surface of this Lambda is the two GET/POST
// shapes below against one host, which keeps the bundle small and the
// security review surface enumerable.
//
// The anon key is public by design (it ships in the website's client bundle);
// row access is governed by Postgres grants/RLS on the Supabase side, which
// only expose the aggregate read paths used here.

const FUEL_NAME = "Unleaded";
const FORECAST_REGION = "brisbane_metro";
const FETCH_TIMEOUT_MS = 8_000;

// Per-warm-container response cache. The site caches these same reads for an
// hour; 15 minutes here keeps repeat MCP calls from re-hitting Supabase while
// staying fresher than the underlying daily-grain data actually changes.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

export type DailyPoint = {
  day: string;
  avg_price: number;
  station_count: number;
};

export type ForecastPoint = {
  day: string;
  predicted_price: number;
  band_low: number | null;
  band_high: number | null;
};

type Env = { url: string; anonKey: string };

function env(): Env {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Server data source is not configured");
  }
  return { url: url.replace(/\/$/, ""), anonKey };
}

async function rest(
  { url, anonKey }: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Body is not surfaced: PostgREST error details are internal.
    throw new Error(`Upstream data request failed (${res.status})`);
  }
  return res.json();
}

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.value as T;
  }
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Latest observed event date, used to anchor the history window (mirrors the
// website: while live ingestion lags, "last N days from today" would return a
// flat carry-forward tail, so we anchor at the newest real event instead).
async function latestEventDate(e: Env): Promise<Date | null> {
  const rows = (await rest(
    e,
    "price_snapshots" +
      `?select=transaction_date_utc&fuel_name=eq.${FUEL_NAME}` +
      "&order=transaction_date_utc.desc&limit=1",
  )) as Array<{ transaction_date_utc: string }>;
  const iso = rows[0]?.transaction_date_utc;
  return iso ? new Date(iso) : null;
}

export async function getRecentHistory(days: number): Promise<DailyPoint[]> {
  return cached(`history:${days}`, async () => {
    const e = env();
    const latest = await latestEventDate(e);
    const end = latest ?? new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    const rows = (await rest(e, "rpc/brisbane_daily_avg_u91", {
      method: "POST",
      body: { start_date: toIsoDate(start), end_date: toIsoDate(end) },
    })) as Array<{ day: string; avg_price: number; station_count: number }>;
    return rows.map((r) => ({
      day: r.day,
      avg_price: Number(Number(r.avg_price).toFixed(3)),
      station_count: r.station_count,
    }));
  });
}

export async function getLatestForecast(): Promise<ForecastPoint[]> {
  return cached("forecast", async () => {
    const e = env();
    const filters =
      `fuel_name=eq.${FUEL_NAME}&region=eq.${FORECAST_REGION}`;
    const latest = (await rest(
      e,
      `forecasts?select=generated_at&${filters}` +
        "&order=generated_at.desc&limit=1",
    )) as Array<{ generated_at: string }>;
    const generatedAt = latest[0]?.generated_at;
    if (!generatedAt) {
      return [];
    }
    const rows = (await rest(
      e,
      "forecasts?select=forecast_for_date,predicted_price,band_low,band_high" +
        `&${filters}&generated_at=eq.${encodeURIComponent(generatedAt)}` +
        "&order=forecast_for_date.asc",
    )) as Array<{
      forecast_for_date: string;
      predicted_price: number;
      band_low: number | null;
      band_high: number | null;
    }>;
    return rows.map((r) => ({
      day: r.forecast_for_date,
      predicted_price: Number(Number(r.predicted_price).toFixed(3)),
      band_low: r.band_low === null ? null : Number(r.band_low),
      band_high: r.band_high === null ? null : Number(r.band_high),
    }));
  });
}

// Test hook: clears the warm-container cache between test cases.
export function clearDataCache(): void {
  cache.clear();
}
