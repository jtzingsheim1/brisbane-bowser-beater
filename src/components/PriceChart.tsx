"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyPoint, ForecastPoint } from "@/lib/aggregates";

type ChartRow = {
  day: string;
  observed: number | null;
  forecast: number | null;
  band: [number, number] | null;
};

function buildRows(
  history: DailyPoint[],
  forecast: ForecastPoint[],
): ChartRow[] {
  const map = new Map<string, ChartRow>();

  for (const h of history) {
    map.set(h.day, {
      day: h.day,
      observed: h.avgPrice,
      forecast: null,
      band: null,
    });
  }
  for (const f of forecast) {
    const existing = map.get(f.day) ?? {
      day: f.day,
      observed: null,
      forecast: null,
      band: null,
    };
    existing.forecast = f.predictedPrice;
    if (f.bandLow !== null && f.bandHigh !== null) {
      existing.band = [f.bandLow, f.bandHigh];
    }
    map.set(f.day, existing);
  }

  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

function formatTick(day: unknown): string {
  if (typeof day !== "string") return "";
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "Australia/Brisbane",
  });
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function PriceChart({
  history,
  forecast,
}: {
  history: DailyPoint[];
  forecast: ForecastPoint[];
}) {
  const rows = buildRows(history, forecast);

  if (rows.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No price data yet.
      </div>
    );
  }

  const firstForecastDay = forecast[0]?.day;

  return (
    <div className="h-72 w-full" aria-label="Brisbane U91 daily average chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          <XAxis
            dataKey="day"
            tickFormatter={formatTick}
            minTickGap={32}
            stroke="#71717a"
            fontSize={12}
          />
          <YAxis
            tickFormatter={formatPrice}
            domain={["auto", "auto"]}
            stroke="#71717a"
            fontSize={12}
            width={56}
          />
          <Tooltip
            labelFormatter={formatTick}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ["—", name];
              const num =
                typeof value === "number" ? value : Number(value as string);
              return [formatPrice(num), name];
            }}
          />
          <Legend />
          {firstForecastDay && (
            <ReferenceLine
              x={firstForecastDay}
              stroke="#a1a1aa"
              strokeDasharray="4 4"
              label={{
                value: "Forecast",
                position: "top",
                fill: "#71717a",
                fontSize: 11,
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey="band"
            fill="#c7d2fe"
            fillOpacity={0.45}
            stroke="none"
            name="Forecast range"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="observed"
            stroke="#1e40af"
            strokeWidth={2}
            dot={false}
            name="Observed (Brisbane average)"
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="#1e40af"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            name="Forecast"
            isAnimationActive={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
