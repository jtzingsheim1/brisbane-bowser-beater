// The MCP server definition: read-only tools over Brisbane Bowser Beater's
// public forecast data, plus (when the RAG stack is wired in) docs Q&A
// tools over the project's own documentation. A fresh server instance is
// created per request (stateless transport), so registration must stay
// cheap.
//
// Language discipline: all descriptions and outputs describe the price cycle
// in observation-only terms (see CLAUDE.md "Legal hygiene"). Forecasts are
// framed as estimates, never guarantees.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRecentHistory, getLatestForecast } from "./data.js";
import { getCycleModel } from "./cycle-model.js";
import {
  askDocs,
  DEFAULT_RESULTS,
  MAX_QUERY_CHARS,
  MAX_RESULTS,
  meetsLanguageDiscipline,
  ragConfigFromEnv,
  searchDocs,
  type RagConfig,
} from "./rag.js";

export const SERVER_NAME = "brisbane-bowser-beater";
export const SERVER_VERSION = "0.2.0";

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

// Appended only when the docs tools are actually registered, so the
// instructions never advertise tools that tools/list does not carry.
const RAG_INSTRUCTIONS =
  " For questions about the project itself (methodology, data licence, " +
  "architecture), use search_docs to find passages in its documentation " +
  "or ask_docs for a cited answer generated from those docs.";

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
  // Read once up front: it decides both the instructions string and
  // whether the docs tools are registered at all.
  const ragConfig = ragConfigFromEnv();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: ragConfig
        ? INSTRUCTIONS + RAG_INSTRUCTIONS
        : INSTRUCTIONS,
    },
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

  // The docs Q&A tools exist only when the RAG stack is deployed and wired
  // in via environment (infra/rag.tf), so tools/list always reflects what
  // can actually be served.
  if (ragConfig) {
    registerRagTools(server, ragConfig);
  }

  return server;
}

function registerRagTools(server: McpServer, config: RagConfig): void {
  server.registerTool(
    "search_docs",
    {
      title: "Search the project's documentation",
      description:
        "Search Brisbane Bowser Beater's own documentation (forecast " +
        "methodology, data licence and attribution, architecture, security " +
        "posture, runbooks) and return the most relevant passages with " +
        "their source files and relevance scores. Retrieval only; nothing " +
        "is generated.",
      inputSchema: {
        query: z
          .string()
          .min(3)
          .max(MAX_QUERY_CHARS)
          .describe("What to look for in the documentation."),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .default(DEFAULT_RESULTS)
          .describe(
            `Number of passages to return (1-${MAX_RESULTS}). ` +
              `Defaults to ${DEFAULT_RESULTS}.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, top_k }) => {
      try {
        const results = await searchDocs(config, query, top_k);
        return jsonResult({
          results_returned: results.length,
          results,
          attribution: ATTRIBUTION,
        });
      } catch {
        return errorResult(
          "The documentation index could not be reached. Try again shortly.",
        );
      }
    },
  );

  server.registerTool(
    "ask_docs",
    {
      title: "Ask the project's documentation",
      description:
        "Ask a question about the Brisbane Bowser Beater project and get a " +
        "concise answer generated only from the project's own " +
        "documentation, with citations back to the source files. Answers " +
        "follow the project's framing: the price cycle is described in " +
        "observational terms, and forecasts are estimates, not guarantees.",
      inputSchema: {
        question: z
          .string()
          .min(3)
          .max(MAX_QUERY_CHARS)
          .describe("The question to answer from the documentation."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ question }) => {
      try {
        const { answer, citations } = await askDocs(config, question);
        if (!meetsLanguageDiscipline(answer)) {
          // Runtime backstop for the project's language discipline: a
          // caller-steered generation that drifts into prohibited framing
          // is dropped rather than served from this endpoint.
          return errorResult(
            "The generated answer did not meet this project's wording " +
              "guidelines, so it was not returned. Try rephrasing the " +
              "question.",
          );
        }
        return jsonResult({ answer, citations, attribution: ATTRIBUTION });
      } catch {
        return errorResult(
          "The documentation answerer could not be reached. Try again " +
            "shortly.",
        );
      }
    },
  );
}
