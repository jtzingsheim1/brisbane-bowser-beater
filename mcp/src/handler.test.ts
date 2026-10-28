// Integration tests: drive the real Lambda handler with synthetic API
// Gateway events and a mocked Supabase fetch, exercising the full JSON-RPC
// path (transport -> server -> tools -> data layer). No network involved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { handler } from "./handler.js";
import { clearDataCache, stalenessThresholdMinutes } from "./data.js";

function rpcEvent(payload: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    path: "/mcp",
    headers: {
      Host: "example.execute-api.ap-southeast-2.amazonaws.com",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
}

function rpc(method: string, params: unknown = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await handler(
    rpcEvent(rpc("tools/call", { name, arguments: args })),
  );
  expect(res.statusCode).toBe(200);
  const parsed = JSON.parse(res.body);
  expect(parsed.error).toBeUndefined();
  return parsed.result;
}

const LATEST_EVENT_ISO = "2026-08-07T20:00:00+00:00";
const HISTORY_ROWS = [
  { day: "2026-08-06", avg_price: 1.6891, station_count: 310 },
  { day: "2026-08-07", avg_price: 1.7012, station_count: 305 },
];
const FORECAST_BATCH = [{ generated_at: "2026-08-07T20:30:00+00:00" }];
const FORECAST_ROWS = [
  {
    forecast_for_date: "2026-08-08",
    predicted_price: 1.712,
    band_low: 1.65,
    band_high: 1.78,
  },
];

// Latest ingestion timestamp the staleness gate reads. Fresh by default;
// null means nothing has ever been ingested.
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function mockSupabase(
  { ingestedAt = minutesAgo(5) }: { ingestedAt?: string | null } = {},
) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("/rest/v1/rpc/latest_snapshot_ingested_at")) {
      body = ingestedAt;
    } else if (url.includes("/rest/v1/rpc/snapshot_event_bound")) {
      // Scalar-returning RPC: PostgREST serialises a bare JSON string.
      body = LATEST_EVENT_ISO;
    } else if (url.includes("/rest/v1/rpc/brisbane_daily_avg_u91")) {
      body = HISTORY_ROWS;
    } else if (url.includes("select=generated_at")) {
      body = FORECAST_BATCH;
    } else if (url.includes("/rest/v1/forecasts")) {
      body = FORECAST_ROWS;
    } else {
      throw new Error(`Unexpected URL in test: ${url}`);
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

// History and forecast include live-API prices, so they must carry the
// publisher licence's cl 4.3 notice (with the current year) and its cl 2.3
// no-republication term, and must not offer them under CC BY.
function expectLicensedAttribution(attribution: string) {
  expect(attribution).toContain("may not be republished");
  expect(attribution).toContain(
    "Based on or contains data provided by the State of Queensland " +
      `(Department of Energy and Climate) ${new Date().getFullYear()}.`,
  );
  expect(attribution).toContain("used in breach of the privacy laws.");
  expect(attribution).not.toContain("CC BY");
}

describe("handler", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    // RAG stays unconfigured here; rag.test.ts covers the five-tool case.
    delete process.env.BBB_KB_ID;
    delete process.env.BBB_RAG_MODEL_ARN;
    clearDataCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects non-POST methods with 405", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await handler({
        ...rpcEvent({}),
        httpMethod: method,
      } as APIGatewayProxyEvent);
      expect(res.statusCode).toBe(405);
      expect(res.headers?.allow).toBe("POST");
    }
  });

  it("rejects JSON-RPC batches (top-level arrays)", async () => {
    const res = await handler(
      rpcEvent([rpc("tools/list", {}, 1), rpc("tools/list", {}, 2)]),
    );
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toContain("Batched");
  });

  it("rejects a malformed JSON body with a parse error", async () => {
    const res = await handler({
      ...rpcEvent({}),
      body: "{ not json",
    } as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it("handles base64-encoded request bodies", async () => {
    const res = await handler({
      ...rpcEvent(rpc("tools/list")),
      body: Buffer.from(JSON.stringify(rpc("tools/list"))).toString("base64"),
      isBase64Encoded: true,
    } as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.tools).toHaveLength(3);
  });

  it("answers initialize with server info", async () => {
    const res = await handler(
      rpcEvent(
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.serverInfo.name).toBe("brisbane-bowser-beater");
    expect(parsed.result.instructions).toContain("estimates");
  });

  it("lists exactly the three data tools when RAG is not configured", async () => {
    const res = await handler(rpcEvent(rpc("tools/list")));
    const parsed = JSON.parse(res.body);
    const names = parsed.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([
      "get_cycle_model",
      "get_forecast",
      "get_recent_history",
    ]);
    for (const tool of parsed.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("serves the cycle model without I/O and without shape by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("no network expected");
      }),
    );
    const result = await callTool("get_cycle_model");
    const payload = JSON.parse(result.content[0].text);
    expect(payload.params.period_days).toBeGreaterThan(30);
    expect(payload.source.n_cycles_used).toBeGreaterThan(0);
    expect(payload.shape).toBeUndefined();
    // Fitted from the open-data CSVs only: CC BY attribution, no licence
    // no-republication term.
    expect(payload.attribution).toContain("CC BY 4.0");
    expect(payload.attribution).toContain("Queensland Treasury");
    expect(payload.attribution).not.toContain("may not be republished");
  });

  it("includes the canonical shape when asked", async () => {
    const result = await callTool("get_cycle_model", { include_shape: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.shape.phase).toHaveLength(100);
    expect(payload.shape.normalised_price).toHaveLength(100);
  });

  it("returns recent history anchored at the latest observed event", async () => {
    const fetchMock = mockSupabase();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callTool("get_recent_history", { days: 30 });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.days_returned).toBe(2);
    expect(payload.series[0]).toEqual({
      day: "2026-08-06",
      avg_price: 1.689,
      station_count: 310,
    });

    const rpcCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("brisbane_daily_avg_u91"),
    );
    expect(rpcCall).toBeDefined();
    const body = JSON.parse(String(rpcCall![1]?.body));
    // Window anchored to the mocked latest event (2026-08-07), not today.
    expect(body.end_date).toBe("2026-08-07");
    expect(body.start_date).toBe("2026-07-08");
    expectLicensedAttribution(payload.attribution);
  });

  it("returns the latest forecast batch", async () => {
    vi.stubGlobal("fetch", mockSupabase());
    const result = await callTool("get_forecast");
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("available");
    expect(payload.series).toEqual([
      {
        day: "2026-08-08",
        predicted_price: 1.712,
        band_low: 1.65,
        band_high: 1.78,
      },
    ]);
    expectLicensedAttribution(payload.attribution);
  });

  it("reports unavailable when no forecast batch exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const body = String(input).includes("latest_snapshot_ingested_at")
          ? JSON.stringify(minutesAgo(5))
          : "[]";
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const result = await callTool("get_forecast");
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("unavailable");
    expectLicensedAttribution(payload.attribution);
  });

  it("degrades to a tool error when the data source is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const res = await handler(
      rpcEvent(rpc("tools/call", { name: "get_recent_history", arguments: {} })),
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.result.isError).toBe(true);
    // Upstream status/details must not leak to the caller.
    expect(parsed.result.content[0].text).not.toContain("500");
  });

  it("sends the anon key only to the configured Supabase host", async () => {
    const fetchMock = mockSupabase();
    vi.stubGlobal("fetch", fetchMock);
    await callTool("get_recent_history", { days: 30 });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/example\.supabase\.co\/rest\/v1\//);
      const headers = init?.headers as Record<string, string>;
      expect(headers.apikey).toBe("test-anon-key");
    }
  });

  describe("staleness gate", () => {
    // Licence cl 2.3 currency: once ingestion falls behind, the licensed
    // tools serve nothing, and never touch the data tables.
    for (const tool of ["get_forecast", "get_recent_history"]) {
      it(`${tool} serves nothing when the latest ingestion is too old`, async () => {
        const fetchMock = mockSupabase({ ingestedAt: minutesAgo(61) });
        vi.stubGlobal("fetch", fetchMock);
        const result = await callTool(tool);
        const payload = JSON.parse(result.content[0].text);
        expect(payload.status).toBe("unavailable");
        expect(payload.series).toEqual([]);
        expect(payload.attribution).toBeUndefined();
        const urls = fetchMock.mock.calls.map(([u]) => String(u));
        expect(urls.every((u) => u.includes("latest_snapshot_ingested_at"))).toBe(true);
      });

      it(`${tool} serves nothing when nothing has been ingested`, async () => {
        vi.stubGlobal("fetch", mockSupabase({ ingestedAt: null }));
        const payload = JSON.parse((await callTool(tool)).content[0].text);
        expect(payload.status).toBe("unavailable");
      });

      it(`${tool} fails closed when the freshness read fails`, async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("oops", { status: 500 })),
        );
        const res = await handler(
          rpcEvent(rpc("tools/call", { name: tool, arguments: {} })),
        );
        const parsed = JSON.parse(res.body);
        expect(parsed.result.isError).toBe(true);
        expect(parsed.result.content[0].text).not.toContain("1.7");
      });
    }

    it("honours BBB_STALENESS_MINUTES", async () => {
      vi.stubEnv("BBB_STALENESS_MINUTES", "360");
      vi.stubGlobal("fetch", mockSupabase({ ingestedAt: minutesAgo(300) }));
      const payload = JSON.parse((await callTool("get_forecast")).content[0].text);
      expect(payload.status).toBe("available");
    });
  });

  describe("stalenessThresholdMinutes", () => {
    it("defaults to 60, ignores invalid values and clamps at 24 h", () => {
      const cases: [string | undefined, number][] = [
        [undefined, 60],
        ["", 60],
        ["abc", 60],
        ["0", 60],
        ["-5", 60],
        ["360", 360],
        ["1e308", 1440],
      ];
      for (const [raw, expected] of cases) {
        if (raw === undefined) vi.stubEnv("BBB_STALENESS_MINUTES", undefined);
        else vi.stubEnv("BBB_STALENESS_MINUTES", raw);
        expect(stalenessThresholdMinutes(), String(raw)).toBe(expected);
      }
    });
  });
});
