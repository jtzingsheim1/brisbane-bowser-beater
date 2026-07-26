"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  anomalyWindow,
  historyArtifact,
} from "@/lib/history/artifacts";

// V1 — the "concept lands immediately" chart: ~3 years of the Brisbane daily
// average, ~20 sawtooth cycles visible at a glance. Statically bundled data
// (analysis/output/history_daily.json) — no runtime fetch, no staleness-gate
// coupling; refreshed with each quarterly re-fit.

function formatTick(day: unknown): string {
  if (typeof day !== "string") return "";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-AU", {
    month: "short",
    year: "2-digit",
    timeZone: "Australia/Brisbane",
  });
}

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

type TooltipProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string }>;
};

function HistoryTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const value = payload[0]?.value;
  if (typeof value !== "number") return null;
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="font-medium text-zinc-700 dark:text-zinc-200">
        {typeof label === "string"
          ? new Date(`${label}T00:00:00Z`).toLocaleDateString("en-AU", {
              day: "numeric",
              month: "short",
              year: "numeric",
              timeZone: "Australia/Brisbane",
            })
          : ""}
      </div>
      <div className="text-zinc-600 dark:text-zinc-300">
        Brisbane average:{" "}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {formatPrice(value)}
        </span>
      </div>
    </div>
  );
}

export default function CycleHistoryChart() {
  const { days, source } = historyArtifact;

  return (
    <div
      className="h-48 w-full"
      role="img"
      aria-label={
        "Line chart of the Brisbane average U91 price from " +
        `${source.span_start} to ${source.span_end}, showing roughly twenty ` +
        "recurring price cycles of around 35 cents each, with one unusual " +
        "period in early 2026 shaded as excluded from cycle fitting."
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={days} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          {anomalyWindow && (
            <ReferenceArea
              x1={anomalyWindow.start}
              x2={anomalyWindow.end}
              fill="var(--chart-anomaly)"
              fillOpacity={0.12}
              stroke="none"
              ifOverflow="hidden"
            />
          )}
          {/* End of the fitted window — the fit and the chart deliberately
              cover different spans, and the marker keeps that honest. */}
          <ReferenceLine
            x={source.fit_span_end}
            stroke="var(--chart-axis)"
            strokeDasharray="4 4"
            strokeOpacity={0.7}
          />
          <XAxis
            dataKey="d"
            tickFormatter={formatTick}
            minTickGap={48}
            stroke="var(--chart-axis)"
            fontSize={11}
          />
          <YAxis
            tickFormatter={formatPrice}
            domain={["auto", "auto"]}
            stroke="var(--chart-axis)"
            fontSize={11}
            width={44}
          />
          <Tooltip content={<HistoryTooltip />} />
          <Line
            type="monotone"
            dataKey="p"
            stroke="var(--chart-line)"
            strokeWidth={1.25}
            dot={false}
            name="Brisbane average U91"
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
