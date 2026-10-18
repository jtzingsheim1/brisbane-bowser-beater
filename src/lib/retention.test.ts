import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLAN_RETENTION_DAYS,
  FORECAST_RETENTION_DAYS,
  pruneOldRows,
  USAGE_RETENTION_MONTHS,
} from "./retention";

type Call = { table: string; column: string; value: string };

// Minimal stand-in for the postgrest builder chain used by pruneOldRows:
// client.from(t).delete().lt(col, value) -> { error }.
function fakeClient(errors: Record<string, { message: string }> = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        delete() {
          return {
            lt(column: string, value: string) {
              calls.push({ table, column, value });
              return Promise.resolve({ error: errors[table] ?? null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const NOW = new Date("2026-08-23T00:00:00.000Z");

describe("pruneOldRows", () => {
  it("deletes only rows older than each retention window", async () => {
    const { client, calls } = fakeClient();
    const result = await pruneOldRows(client, NOW);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      table: "forecasts",
      column: "generated_at",
    });
    expect(calls[1]).toMatchObject({
      table: "agent_plans",
      column: "plan_date",
    });
    expect(calls[2]).toMatchObject({
      table: "usage_monthly_visitors",
      column: "period_month",
    });

    // Cutoffs land exactly one retention window back, never in the future.
    const forecastAgeDays =
      (NOW.getTime() - Date.parse(result.forecastsCutoff)) / 86_400_000;
    expect(forecastAgeDays).toBe(FORECAST_RETENTION_DAYS);
    const planAgeDays =
      (NOW.getTime() - Date.parse(`${result.agentPlansCutoff}T00:00:00Z`)) /
      86_400_000;
    expect(planAgeDays).toBe(AGENT_PLAN_RETENTION_DAYS);
  });

  it("keeps the current month and the twelve before it of visitor hashes", async () => {
    expect(USAGE_RETENTION_MONTHS).toBe(13);
    const { client } = fakeClient();
    // NOW is 2026-08-23: keep 2025-08 through 2026-08, drop 2025-07 and older.
    const { usageCutoff } = await pruneOldRows(client, NOW);
    expect(usageCutoff).toBe("2025-08-01");
    // Crosses a year boundary cleanly from January.
    const jan = await pruneOldRows(
      fakeClient().client,
      new Date("2027-01-05T00:00:00.000Z"),
    );
    expect(jan.usageCutoff).toBe("2026-01-01");
  });

  it("compares agent_plans on a bare date, not a timestamp", async () => {
    const { client } = fakeClient();
    const { agentPlansCutoff } = await pruneOldRows(client, NOW);
    expect(agentPlansCutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("cannot delete a batch written moments ago", async () => {
    const { client } = fakeClient();
    const { forecastsCutoff } = await pruneOldRows(client, NOW);
    // A batch generated "now" must sort after the cutoff, so `lt` misses it.
    expect(NOW.toISOString() > forecastsCutoff).toBe(true);
  });

  it("collects errors instead of throwing, and still tries every table", async () => {
    const { client, calls } = fakeClient({
      forecasts: { message: "permission denied" },
    });
    const result = await pruneOldRows(client, NOW);
    expect(calls).toHaveLength(3); // the other tables are still attempted
    expect(result.errors).toEqual(["forecasts: permission denied"]);
  });

  it("reports errors from every table", async () => {
    const { client } = fakeClient({
      forecasts: { message: "boom" },
      agent_plans: { message: "bang" },
      usage_monthly_visitors: { message: "crash" },
    });
    const result = await pruneOldRows(client, NOW);
    expect(result.errors).toEqual([
      "forecasts: boom",
      "agent_plans: bang",
      "usage_monthly_visitors: crash",
    ]);
  });
});
