import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { getForecastTool, getRecentHistoryTool } from "@/lib/agent/tools";
import { checkAgentRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 16_000;
const MAX_OUTPUT_TOKENS = 1500;
const MAX_STEPS = 6;
const MODEL_ID = "claude-sonnet-4-6";

type UIMessagePart = UIMessage["parts"][number];

function totalTextChars(messages: UIMessage[]): number {
  return messages.reduce(
    (acc, m) =>
      acc +
      m.parts.reduce(
        (p: number, part: UIMessagePart) =>
          p + (part.type === "text" ? part.text.length : 0),
        0,
      ),
    0,
  );
}

export async function POST(req: Request) {
  // BYO-key (cost defence layer 4): an `x-anthropic-key` header overrides the
  // server key, so the caller pays for their own usage. No UI exposes this — it
  // is scaffolding for power users / load shedding.
  const byoKey = req.headers.get("x-anthropic-key")?.trim() || null;
  if (!process.env.ANTHROPIC_API_KEY && !byoKey) {
    return Response.json(
      {
        error:
          "Agent not configured. Set ANTHROPIC_API_KEY to enable the planner.",
      },
      { status: 503 },
    );
  }

  // Per-IP rate limit (cost defence layer 2). No-op until Upstash is provisioned.
  const ip = getClientIp(req.headers) ?? "unknown";
  const rate = await checkAgentRateLimit(ip);
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many requests — give it a moment and try again." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  let body: { messages?: UIMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("Missing messages", { status: 400 });
  }
  if (messages.length > MAX_MESSAGES) {
    return new Response("Too many messages", { status: 400 });
  }
  if (totalTextChars(messages) > MAX_TOTAL_CHARS) {
    return new Response("Input too large", { status: 400 });
  }

  const modelMessages = await convertToModelMessages(messages);

  const provider = byoKey ? createAnthropic({ apiKey: byoKey }) : anthropic;
  const result = streamText({
    model: provider(MODEL_ID),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: {
      get_forecast: getForecastTool,
      get_recent_history: getRecentHistoryTool,
    },
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  return result.toUIMessageStreamResponse();
}
