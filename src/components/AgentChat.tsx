"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Starter chip definitions. Structure is locked (see CLAUDE.md
// "Agent → Starter chip quadrant" and SYSTEM_PROMPT). Copy/tone is the
// open polish item — feel free to rewrite.
type Chip = {
  id: "A" | "B" | "C" | "D";
  label: string;
  kickoff: string;
};

// Quadrant order is load-bearing: index maps to grid position (A top-left …
// D bottom-right), which the axis labels rely on. Labels are plain statements
// of the square's coordinates; the richer situation detail lives in `kickoff`
// (what's actually sent to the agent).
const CHIPS: Chip[] = [
  {
    id: "A",
    label: "Weekly or more, fixed routine",
    kickoff:
      "I fill up about weekly, on much the same days, and I can't really shift when. Help me get the most out of the cycle within those constraints.",
  },
  {
    id: "B",
    label: "Weekly or more, flexible",
    kickoff:
      "I fill up about weekly, but I can move the day by a few days either way. Help me work the cycle to my advantage.",
  },
  {
    id: "C",
    label: "Every 2+ weeks, fixed routine",
    kickoff:
      "I only fill up every couple of weeks or so, so the next one matters — and I can't easily shift its timing. Help me nail the timing and the station. (If it's for a road trip: the trip date is fixed, but I can choose when to fill beforehand.)",
  },
  {
    id: "D",
    label: "Every 2+ weeks, flexible",
    kickoff:
      "I fill up every couple of weeks at most, and I've got plenty of latitude on when. Help me build a fill rhythm around the cycle.",
  },
];

// Plain-language labels for the agent's tools, so the visible tool calls read
// as "what the planner is doing" rather than raw function names. The agentic
// loop (decide → call tool → read live data → answer) is part of the product's
// transparency story, so we surface it prominently rather than as a footnote.
const TOOL_LABELS: Record<
  string,
  { icon: string; active: string; done: string; noun: string }
> = {
  get_forecast: {
    icon: "📈",
    active: "Reading the live forecast…",
    done: "Read the live forecast",
    noun: "the live forecast",
  },
  get_recent_history: {
    icon: "📊",
    active: "Checking recent Brisbane prices…",
    done: "Checked recent Brisbane prices",
    noun: "recent prices",
  },
};

function formatShortDate(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "Australia/Brisbane",
  });
}

// A short, honest summary of what a finished tool call returned — enough to show
// the answer is grounded in real data, without restating the whole payload.
function toolPeek(name: string, output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (name === "get_forecast") {
    if (o.status === "unavailable") return "not enabled yet";
    const series = o.series as
      | Array<{ day: string; predicted_price: number }>
      | undefined;
    if (!series?.length) return null;
    const trough = series.reduce((lo, p) =>
      p.predicted_price < lo.predicted_price ? p : lo,
    );
    return `low ~ ${formatShortDate(trough.day)}`;
  }
  if (name === "get_recent_history") {
    return typeof o.days_returned === "number"
      ? `${o.days_returned} days`
      : null;
  }
  return null;
}

type ToolPart = {
  type: string;
  state?:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  output?: unknown;
};

// The planner replies in markdown (bold, lists, the occasional table). Render
// it so those come out formatted rather than as literal `**` / pipe characters.
// react-markdown does not emit raw HTML, so model output can't inject markup.
function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-zinc max-w-none dark:prose-invert prose-headings:font-semibold prose-table:text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolActivity({ part }: { part: ToolPart }) {
  const name = part.type.replace(/^tool-/, "");
  const meta = TOOL_LABELS[name] ?? {
    icon: "🔧",
    active: `Calling ${name}…`,
    done: `Called ${name}`,
    noun: name,
  };
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const errored = part.state === "output-error";
  const peek =
    part.state === "output-available" ? toolPeek(name, part.output) : null;

  return (
    <div className="flex items-center gap-2 rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      <span aria-hidden="true">{meta.icon}</span>
      {running ? (
        <>
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
          <span>{meta.active}</span>
        </>
      ) : errored ? (
        <span>
          Couldn&rsquo;t reach {meta.noun} &mdash; answering from what I have.
        </span>
      ) : (
        <>
          <span className="text-emerald-600 dark:text-emerald-400">
            &#10003;
          </span>
          <span>{meta.done}</span>
          {peek && <span className="text-zinc-400">&middot; {peek}</span>}
        </>
      )}
    </div>
  );
}

export default function AgentChat() {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/agent" }),
    [],
  );
  const { messages, sendMessage, status, error, regenerate } = useChat({
    transport,
  });

  const isBusy = status === "submitted" || status === "streaming";
  const showChips = messages.length === 0;

  // Keep the latest output in view as the plan streams in — but only if the
  // user is already near the bottom, so we don't yank them back down while
  // they're scrolling up to re-read.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div
        ref={scrollRef}
        className="max-h-[480px] space-y-4 overflow-y-auto px-5 py-4"
      >
        {showChips && (
          <div>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Which sounds most like you? Tap a square to brief the agent
              &mdash; or just describe your situation.
            </p>
            {/* Quadrant: columns = flexibility (fixed routine → flexible),
                rows = frequency (weekly+ → every 2+ weeks). The split sits at
                roughly fortnightly — the estimated median Brisbane fill interval
                — so the four cells land on four roughly equal groups. The axis
                cues reinforce what each chip already states. */}
            <div className="grid grid-cols-[1.25rem_1fr] gap-x-1.5">
              <div aria-hidden="true" />
              <div
                aria-hidden="true"
                className="mb-1 flex items-center justify-between px-1 text-[11px] uppercase tracking-wide text-zinc-600 dark:text-zinc-300"
              >
                <span>&larr; fixed routine</span>
                <span>flexible &rarr;</span>
              </div>
              <div
                aria-hidden="true"
                className="flex items-center justify-center"
              >
                <span className="text-[11px] uppercase tracking-wide text-zinc-600 [writing-mode:vertical-rl] dark:text-zinc-300">
                  weekly+ &rarr; every 2+ weeks
                </span>
              </div>
              {/* Tint deepens toward the top-right (often + flexible) using
                  the chart's band colour, so the grid reads as a "map" at a
                  glance. Chips are translucent cards floating on it. */}
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-gradient-to-tr from-indigo-50 to-indigo-200/70 p-2 dark:from-indigo-950/40 dark:to-indigo-900/30">
                {CHIPS.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() => sendMessage({ text: chip.kickoff })}
                    className="rounded-md border border-white/70 bg-white/75 px-4 py-4 text-left text-sm font-medium text-zinc-800 transition-colors hover:border-indigo-300 hover:bg-white disabled:opacity-50 dark:border-zinc-700/50 dark:bg-zinc-900/60 dark:text-zinc-100 dark:hover:border-indigo-500/60 dark:hover:bg-zinc-900"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="text-sm">
            <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">
              {m.role === "user" ? "You" : "AI agent"}
            </div>
            <div className="space-y-2 leading-6 text-zinc-900 dark:text-zinc-100">
              {m.parts.map((p, i) => {
                if (p.type === "text") {
                  return m.role === "assistant" ? (
                    <MarkdownMessage key={i} text={p.text} />
                  ) : (
                    <div key={i} className="whitespace-pre-wrap">
                      {p.text}
                    </div>
                  );
                }
                if (typeof p.type === "string" && p.type.startsWith("tool-")) {
                  return (
                    <ToolActivity key={i} part={p as unknown as ToolPart} />
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400">
            Something went wrong generating your plan.{" "}
            <button
              type="button"
              onClick={() => regenerate()}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
      <form
        className="flex gap-2 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || isBusy) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          className="flex-1 rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-800 dark:text-zinc-200"
          value={input}
          placeholder="Or describe your situation in your own words…"
          onChange={(e) => setInput(e.currentTarget.value)}
          disabled={isBusy}
        />
        <button
          type="submit"
          disabled={!input.trim() || isBusy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {isBusy ? "Thinking…" : "Send"}
        </button>
      </form>
    </div>
  );
}
