import { tool } from "ai";
import { z } from "zod";
import {
  getBrisbaneDailyU91History,
  getLatestForecast,
} from "@/lib/aggregates";

// Tool implementations exposed to the fuel strategist agent.
// See SYSTEM_PROMPT for how the agent is expected to use them.

export const getRecentHistoryTool = tool({
  description:
    "Brisbane area daily aggregate U91 averages for the past N days. Use to ground recommendations in observed pattern.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(7)
      .max(120)
      .default(60)
      .describe("Number of days of history to return. Defaults to 60."),
  }),
  execute: async ({ days }) => {
    const history = await getBrisbaneDailyU91History(days);
    return {
      days_returned: history.length,
      series: history.map((h) => ({
        day: h.day,
        avg_price: Number(h.avgPrice.toFixed(3)),
        station_count: h.stationCount,
      })),
    };
  },
});

export const getForecastTool = tool({
  description:
    "Today's forecast for Brisbane area U91. Returns predicted price for each day in the projection window plus optional uncertainty band. Returns status='unavailable' if forecasting is not yet enabled.",
  inputSchema: z.object({}),
  execute: async () => {
    const forecast = await getLatestForecast();
    if (forecast.length === 0) {
      return {
        status: "unavailable" as const,
        message:
          "Forecast generation is not yet enabled. Reason about timing from get_recent_history only and avoid invented dates.",
        series: [],
      };
    }
    return {
      status: "available" as const,
      series: forecast.map((f) => ({
        day: f.day,
        predicted_price: Number(f.predictedPrice.toFixed(3)),
        band_low: f.bandLow,
        band_high: f.bandHigh,
      })),
    };
  },
});
