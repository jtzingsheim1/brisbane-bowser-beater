"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";

// Starter chip definitions. Structure is locked (see CLAUDE.md
// "Agent → Starter chip quadrant" and SYSTEM_PROMPT). Copy/tone is the
// open polish item — feel free to rewrite.
type Chip = {
  id: "A" | "B" | "C" | "D";
  label: string;
  hint: string;
  kickoff: string;
};

const CHIPS: Chip[] = [
  {
    id: "A",
    label: "Routine commuter",
    hint: "Frequent fills, locked-in schedule",
    kickoff:
      "I'm a routine commuter — I fill every week on roughly the same days, and I don't have much flexibility on when I can fill. Help me time my fills around the cycle.",
  },
  {
    id: "B",
    label: "Frequent + flexible",
    hint: "Frequent fills, schedule has wiggle room",
    kickoff:
      "I fill frequently (weekly or so), and I've got room to shift my fill day around. Help me work the cycle to my advantage.",
  },
  {
    id: "C",
    label: "Tight single fill",
    hint: "Infrequent fills, locked-in timing",
    kickoff:
      "I don't fill often, and when I do my timing is pretty constrained. Help me nail the next one. (If I mention a road trip, the deadline is fixed but the prep-fill timing has some flex.)",
  },
  {
    id: "D",
    label: "Light + flexible",
    hint: "Infrequent fills, lots of flexibility",
    kickoff:
      "I'm a light driver with lots of slack on when I fill. Help me design my fill cadence around the cycle.",
  },
];

export default function AgentChat() {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/agent" }),
    [],
  );
  const { messages, sendMessage, status, error } = useChat({ transport });

  const isBusy = status === "submitted" || status === "streaming";
  const showChips = messages.length === 0;

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="max-h-[480px] space-y-4 overflow-y-auto px-5 py-4">
        {showChips && (
          <div>
            <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
              Pick the option that best describes your situation, or just
              describe it in your own words below.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => sendMessage({ text: chip.kickoff })}
                  className="rounded-md border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                >
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {chip.label}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {chip.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="text-sm">
            <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">
              {m.role === "user" ? "You" : "Planner"}
            </div>
            <div className="space-y-2 leading-6 text-zinc-900 dark:text-zinc-100">
              {m.parts.map((p, i) => {
                if (p.type === "text") {
                  return (
                    <div key={i} className="whitespace-pre-wrap">
                      {p.text}
                    </div>
                  );
                }
                if (typeof p.type === "string" && p.type.startsWith("tool-")) {
                  const name = p.type.replace(/^tool-/, "");
                  return (
                    <div
                      key={i}
                      className="text-xs italic text-zinc-500 dark:text-zinc-400"
                    >
                      &middot; called {name}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400">
            Something went wrong. The planner may not be configured yet.
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
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          value={input}
          placeholder="Describe your situation…"
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
