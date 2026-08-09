// The MCP server definition: three read-only tools over Brisbane Bowser
// Beater's public forecast data. A fresh server instance is created per
// request (stateless transport), so registration here must stay cheap.
//
// Language discipline: all descriptions and outputs describe the price cycle
// in observation-only terms (see CLAUDE.md "Legal hygiene"). Forecasts are
// framed as estimates, never guarantees.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRecentHistory, getLatestForecast } from "./data.js";
import { getCycleModel } from "./cycle-model.js";

export const SERVER_NAME = "brisbane-bowser-beater";
export const SERVER_VERSION = "0.1.0";

const ATTRIBUTION =
  "Data: QLD Fuel Price Reporting, data.qld.gov.au (CC BY 4.0). " +
  "Derived aggregates by Brisbane Bowser Beater " +
  "(https://brisbane-bowser-beater.vercel.app/about/data). " +
  "General information only; prices and forecasts are estimates.";

const INSTRUCTIONS =
  "Read-only data about Brisbane's recurring retail fuel price cycle, from " +
  "the Brisbane Bowser Beater project. All prices are Brisbane-area daily " +
  "average U91 (regular unleaded) in AUD per litre; there is no per-station " +
  "data. Forecasts are estimates, not guarantees. Typical use: call " +
  "get_forecast for the forward view, get_recent_history for observed " +
  "context, and get_cycle_model for the long-run cycle characterisation.";

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_forecast",
    {
      title: "Brisbane U91 price forecast",
      description:
        "The latest ~30-day Brisbane-area average U91 price forecast: one " +
        "predicted price per day, with an uncertainty band where available. " +
        "Regenerated daily from the observed cycle. Returns " +
        "status='unavailable' if no forecast batch exists yet.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const series = await getLatestForecast();
        if (series.length === 0) {
          return jsonResult({
            status: "unavailable",
            message: "No forecast batch is available yet.",
            series: [],
            attribution: ATTRIBUTION,
          });
        }
        return jsonResult({
          status: "available",
          unit: "AUD per litre",
          series,
          attribution: ATTRIBUTION,
        });
      } catch {
        return errorResult(
          "The forecast source could not be reached. Try again shortly.",
        );
      }
    },
  );

  server.registerTool(
    "get_recent_history",
    {
      title: "Recent Brisbane U91 daily averages",
      description:
        "Observed Brisbane-area daily average U91 prices for the past N " +
        "days (7 to 120, default 60), each with the number of stations " +
        "contributing to that day's average. Useful for seeing where the " +
        "current cycle sits.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(7)
          .max(120)
          .default(60)
          .describe("Days of history to return (7-120). Defaults to 60."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days }) => {
      try {
        const series = await getRecentHistory(days);
        return jsonResult({
          days_returned: series.length,
          unit: "AUD per litre",
          series,
          attribution: ATTRIBUTION,
        });
      } catch {
        return errorResult(
          "The history source could not be reached. Try again shortly.",
        );
      }
    },
  );

  server.registerTool(
    "get_cycle_model",
    {
      title: "Brisbane cycle characterisation",
      description:
        "The measured characterisation of Brisbane's recurring U91 price " +
        "cycle, fitted offline from ~3 years of QLD open data: typical " +
        "period, trough-to-peak swing, asymmetry, uncertainty, and drift " +
        "notes. Set include_shape=true to also get the 100-point canonical " +
        "cycle shape the forecast projects forward. Static data; no live " +
        "lookup involved.",
      inputSchema: {
        include_shape: z
          .boolean()
          .default(false)
          .describe(
            "Include the 100-point normalised canonical cycle shape " +
              "(adds ~6 KB).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_shape }) => {
      return jsonResult({
        ...getCycleModel(include_shape),
        attribution: ATTRIBUTION,
      });
    },
  );

  return server;
}
