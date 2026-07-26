"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { buildShapeRows, cycleShapesArtifact } from "@/lib/history/artifacts";

// V2 — the model-fit visual: every fitted cycle phase-normalised and drawn
// faint, with the bold canonical template on top. The bold line comes straight
// from cycle_params.json (the recency-weighted template the forecast actually
// projects forward) — never recomputed — so this chart is, by construction,
// a picture of the real model.
//
// Deliberately NO tooltip: this is a shape gestalt, not a lookup surface — a
// hover panel listing twenty normalised values would be pure noise.

const { rows, cycleKeys } = buildShapeRows();

function formatPhase(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default function CycleShapeChart() {
  const n = cycleShapesArtifact.source.n_cycles;

  return (
    <div
      className="h-48 w-full"
      role="img"
      aria-label={
        `Overlay of ${n} Brisbane price cycles, each normalised from one ` +
        "cheapest day to the next, shown as faint lines, with the bold " +
        "average cycle shape on top: a fast climb over roughly the first " +
        "40% of the cycle, then a slower easing back down."
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis
            dataKey="phase"
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tickFormatter={formatPhase}
            stroke="var(--chart-axis)"
            fontSize={11}
          />
          <YAxis
            domain={[0, 1.02]}
            ticks={[0, 1]}
            tickFormatter={(v: number) => (v === 0 ? "low" : "high")}
            stroke="var(--chart-axis)"
            fontSize={11}
            width={44}
          />
          {cycleKeys.map((key) => (
            <Line
              key={key}
              dataKey={key}
              stroke="var(--chart-faint)"
              strokeOpacity={0.35}
              strokeWidth={1}
              dot={false}
              isAnimationActive={false}
            />
          ))}
          <Line
            dataKey="canonical"
            stroke="var(--chart-line)"
            strokeWidth={2.5}
            dot={false}
            name="Average cycle shape"
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
