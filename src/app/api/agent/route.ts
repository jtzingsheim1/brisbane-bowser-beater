import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { getForecastTool, getRecentHistoryTool } from "@/lib/agent/tools";

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
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          "Agent not configured. Set ANTHROPIC_API_KEY to enable the planner.",
      },
      { status: 503 },
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

  const result = streamText({
    model: anthropic(MODEL_ID),
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
