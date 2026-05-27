"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyPoint, Deadzone, ForecastPoint } from "@/lib/aggregates";

type ChartRow = {
  day: string;
  observed: number | null;
  forecast: number | null;
  band: [number, number] | null;
};

function inDeadzone(day: string, deadzone: Deadzone | null): boolean {
  return deadzone !== null && day >= deadzone.start && day <= deadzone.end;
}

function buildRows(
  history: DailyPoint[],
  forecast: ForecastPoint[],
  deadzone: Deadzone | null,
): ChartRow[] {
  const lastObservedDay = history.reduce<string | null>(
    (max, h) => (max === null || h.day > max ? h.day : max),
    null,
  );

  // The model anchors on the most recent observed day, so its first point(s)
  // can fall on days we already display as observed. Don't redraw the forecast
  // over real data — only render the part that extends past the last observed
  // day. (The model's anchoring is unchanged; this is purely display.)
  const futureForecast =
    lastObservedDay === null
      ? forecast
      : forecast.filter((f) => f.day > lastObservedDay);

  const byDay = new Map<string, ChartRow>();

  for (const h of history) {
    // Bridge the dashed forecast line to the solid observed line: seed the
    // forecast value (and a zero-width band) at the last observed point so the
    // two lines meet cleanly rather than overlapping or leaving a gap.
    const isAnchor = h.day === lastObservedDay && futureForecast.length > 0;
    byDay.set(h.day, {
      day: h.day,
      // Days inside the no-data gap are forward-filled by the RPC; null them so
      // the observed line breaks rather than drawing a misleading flat line.
      // The day slot is kept so the axis spacing stays calendar-accurate and
      // the hatched ReferenceArea lines up.
      observed: inDeadzone(h.day, deadzone) ? null : h.avgPrice,
      forecast: isAnchor ? h.avgPrice : null,
      band: isAnchor ? [h.avgPrice, h.avgPrice] : null,
    });
  }

  for (const f of futureForecast) {
    const existing = byDay.get(f.day);
    byDay.set(f.day, {
      day: f.day,
      observed: existing?.observed ?? null,
      forecast: f.predictedPrice,
      band:
        f.bandLow !== null && f.bandHigh !== null
          ? [f.bandLow, f.bandHigh]
          : (existing?.band ?? null),
    });
  }

  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
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

type ChartTooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload: ChartRow }>;
};

// Custom tooltip so we only show the series that actually have a value at the
// hovered day (no "Observed: —" on a forecast day, and vice-versa) and so the
// uncertainty band renders as a proper "$low – $high" range instead of trying
// to coerce the [low, high] tuple to a single number (which showed "NaN").
function ChartTooltip({ active, label, payload }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;

  const lines: Array<{ label: string; value: string }> = [];
  if (row.observed !== null) {
    lines.push({ label: "Observed", value: formatPrice(row.observed) });
  }
  if (row.forecast !== null) {
    lines.push({ label: "Forecast", value: formatPrice(row.forecast) });
  }
  // Skip the zero-width band at the bridge point (band low === high there).
  if (row.band !== null && row.band[0] !== row.band[1]) {
    lines.push({
      label: "Forecast range",
      value: `${formatPrice(row.band[0])} – ${formatPrice(row.band[1])}`,
    });
  }
  if (lines.length === 0) return null;

  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 font-medium text-zinc-700 dark:text-zinc-200">
        {typeof label === "string" ? formatTick(label) : ""}
      </div>
      {lines.map((l) => (
        <div key={l.label} className="text-zinc-600 dark:text-zinc-300">
          {l.label}:{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {l.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function PriceChart({
  history,
  forecast,
  deadzone,
}: {
  history: DailyPoint[];
  forecast: ForecastPoint[];
  deadzone: Deadzone | null;
}) {
  const rows = buildRows(history, forecast, deadzone);

  // Visible bounds of the no-data band: the first and last in-window days that
  // fall inside the deadzone. As the 60-day window slides forward, the left
  // edge falls off and this band shrinks a day at a time until it's gone.
  const deadzoneDays = history
    .map((h) => h.day)
    .filter((day) => inDeadzone(day, deadzone))
    .sort();
  const deadzoneBounds =
    deadzoneDays.length > 0
      ? { x1: deadzoneDays[0], x2: deadzoneDays[deadzoneDays.length - 1] }
      : null;

  // The band label is rendered centred regardless of band width, so it has to
  // degrade as the window slides and the band narrows: full sentence while
  // there's room, a terse "No data" when it's tight, then nothing once even
  // that would overlap the line. Thresholds are in days (≈7px each at this
  // chart width).
  const deadzoneLabel =
    deadzoneDays.length >= 21
      ? "No data for this period"
      : deadzoneDays.length >= 8
        ? "No data"
        : null;

  if (rows.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No price data yet.
      </div>
    );
  }

  return (
    <div className="h-72 w-full" aria-label="Brisbane U91 daily average chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <defs>
            <pattern
              id="deadzoneHatch"
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="#71717a" fillOpacity={0.06} />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="#71717a"
                strokeOpacity={0.25}
                strokeWidth={1.5}
              />
            </pattern>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
          {deadzoneBounds && (
            <ReferenceArea
              x1={deadzoneBounds.x1}
              x2={deadzoneBounds.x2}
              fill="url(#deadzoneHatch)"
              fillOpacity={1}
              stroke="none"
              ifOverflow="hidden"
              label={
                deadzoneLabel
                  ? {
                      value: deadzoneLabel,
                      position: "center",
                      fill: "#a1a1aa",
                      fontSize: 11,
                    }
                  : undefined
              }
            />
          )}
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
          <Tooltip content={<ChartTooltip />} />
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
