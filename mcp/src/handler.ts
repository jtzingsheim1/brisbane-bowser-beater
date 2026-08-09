// Lambda entry point: bridges an API Gateway (REST, payload v1.0) proxy event
// to the MCP SDK's web-standard streamable HTTP transport and back.
//
// The transport runs stateless (no sessions) with JSON responses, so every
// invocation is a self-contained request/response pair: build a fresh server,
// handle the one request, convert the Response. No SSE streams are ever
// opened, which is exactly what a buffered Lambda proxy integration needs.
//
// Authentication note: the API key gate lives in front of this code, at API
// Gateway (x-api-key + usage plan). By the time this handler runs, the
// gateway has already authenticated and rate-limited the caller.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./server.js";

// Fixed internal origin. This is a stateless POST-only server that makes no
// host- or origin-based decision, so we do NOT reconstruct the URL from the
// caller-supplied Host header (avoids the reconstructed-from-Host pattern
// entirely); the path is the one route the gateway allows.
const INTERNAL_ORIGIN = "https://bbb-mcp.internal";

function toRequest(event: APIGatewayProxyEvent): Request {
  const url = `${INTERNAL_ORIGIN}${event.path}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const body =
    event.body === null || event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  return new Request(url, { method: event.httpMethod, headers, body });
}

async function toResult(response: Response): Promise<APIGatewayProxyResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", allow: "POST" },
    body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    isBase64Encoded: false,
  };
}

function decodeBody(event: APIGatewayProxyEvent): string {
  if (event.body === null || event.body === undefined) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  try {
    // Stateless MCP needs only POST. GET would open a hanging SSE stream
    // (fatal on a buffered Lambda) and DELETE is session teardown, which
    // doesn't exist here -- both are rejected before touching the transport.
    if (event.httpMethod !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed. Use POST.");
    }

    // Reject JSON-RPC batches (top-level arrays). Batching was removed in the
    // 2025-06-18 MCP spec, and accepting it here would let one authenticated,
    // quota-metered request fan out into N tool executions -- an upstream
    // amplification path around the usage plan. We parse once and hand the
    // parsed body to the transport so it isn't parsed twice.
    const raw = decodeBody(event);
    let parsedBody: unknown;
    try {
      parsedBody = raw.length ? JSON.parse(raw) : undefined;
    } catch {
      return jsonRpcError(400, -32700, "Parse error: body is not valid JSON.");
    }
    if (Array.isArray(parsedBody)) {
      return jsonRpcError(
        400,
        -32600,
        "Batched requests are not supported. Send one request at a time.",
      );
    }

    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toRequest(event), {
        parsedBody,
      });
      return await toResult(response);
    } finally {
      await server.close().catch(() => undefined);
    }
  } catch {
    // Last-resort guard: never let an unexpected throw surface as a raw
    // API Gateway 502. Details stay in CloudWatch, not in the response.
    return jsonRpcError(500, -32603, "Internal error. Try again shortly.");
  }
}
