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

function toRequest(event: APIGatewayProxyEvent): Request {
  const host = event.headers?.Host ?? event.headers?.host ?? "localhost";
  const url = `https://${host}${event.path}`;
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

const methodNotAllowed: APIGatewayProxyResult = {
  statusCode: 405,
  headers: { "content-type": "application/json", allow: "POST" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  }),
  isBase64Encoded: false,
};

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  // Stateless MCP needs only POST. GET would open a hanging SSE stream
  // (fatal on a buffered Lambda) and DELETE is session teardown, which
  // doesn't exist here -- both are rejected before touching the transport.
  if (event.httpMethod !== "POST") {
    return methodNotAllowed;
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(toRequest(event));
    return await toResult(response);
  } finally {
    await server.close().catch(() => undefined);
  }
}
