"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";

export default function AgentChat() {
  const [input, setInput] = useState("");
  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/agent" }),
    [],
  );
  const { messages, sendMessage, status, error } = useChat({ transport });

  const isBusy = status === "submitted" || status === "streaming";

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="max-h-[480px] space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Tell the planner your situation &mdash; e.g. &ldquo;Mon&ndash;Fri
            commute, fill weekly, half a tank now&rdquo;.
          </p>
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
