import { createHash } from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { supabaseAdmin } from "@/lib/supabase/server";

// Per-(situation, day) cache of the agent's plan (cost defence layer 3). The
// high-value hit is the starter chips: identical default kickoffs hash the
// same. Keyed by day because plans embed that day's forecast. All calls are
// best-effort — the route swallows failures and falls back to a live call, so
// the cache can never break the agent.

// Namespace the key so a future multi-fuel / multi-region build can't collide
// with today's single-fuel cache.
const CACHE_NAMESPACE = "u91:brisbane_metro";

// Non-text parts collapse to their part type, not their payload — two
// conversations differing only inside tool-call details hash the same. That
// scope narrowing is deliberate: the intended hot path is first-turn chip
// kickoffs (no tool parts in the *user* messages being hashed), and plans are
// day-scoped, so the worst case is a same-day stale-ish replay, clearly
// labelled by CACHED_PLAN_NOTICE below.
function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("");
}

export function hashSituation(messages: UIMessage[]): string {
  const canonical = [
    CACHE_NAMESPACE,
    ...messages.map((m) => `${m.role}:${messageText(m)}`),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getCachedPlan(situationHash: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("agent_plans")
    .select("plan_text")
    .eq("situation_hash", situationHash)
    .eq("plan_date", utcToday())
    .maybeSingle();
  if (error) throw error;
  return data?.plan_text ?? null;
}

export async function putCachedPlan(
  situationHash: string,
  planText: string,
): Promise<void> {
  if (!planText.trim()) return; // don't cache empty/aborted generations
  const { error } = await supabaseAdmin()
    .from("agent_plans")
    .upsert(
      { situation_hash: situationHash, plan_date: utcToday(), plan_text: planText },
      { onConflict: "situation_hash,plan_date", ignoreDuplicates: false },
    );
  if (error) throw error;
}

// A cache hit skips the live tool-call activity the UI normally streams, so
// the replay says what it is instead of passing as a fresh generation — part
// of the transparency story alongside the privacy pane's "caching is
// anonymous" bullet. Added at replay time only; the stored plan stays clean.
export const CACHED_PLAN_NOTICE =
  "*(Using a saved plan from earlier today — same situation, same forecast, same strategy.)*\n\n";

// Replays a cached plan as a UI message stream, so the client renders it
// like a live response (minus the live tool-call markers, which a cache hit
// skips — no tools are called).
export function cachedPlanResponse(planText: string): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = "cached-0";
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: CACHED_PLAN_NOTICE + planText });
      writer.write({ type: "text-end", id });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
