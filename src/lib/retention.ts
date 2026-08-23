import type { SupabaseClient } from "@supabase/supabase-js";

// Row retention for the two tables that would otherwise grow without bound:
// `forecasts` (~30 rows/day, one batch per generation) and `agent_plans` (the
// per-(situation, day) plan cache).
//
// This runs from the daily forecast generator (scripts/generate-forecast.ts),
// which is what the GitHub Actions schedule actually invokes — deliberately
// NOT from /api/cron/forecast, which nothing schedules and which is open when
// CRON_SECRET is unset (see docs/abuse-audit.md vector 6: that route stays
// write-only so an unauthenticated hit can never delete anything).
//
// Both windows are generous: the UI only ever reads the latest forecast batch,
// and cached plans are only ever read same-day. Kept long enough that
// retrospective forecast-accuracy checks (migration 0001's stated reason for
// keeping history) still have ~6 months to work with.
export const FORECAST_RETENTION_DAYS = 183;
export const AGENT_PLAN_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export type PruneResult = {
  forecastsCutoff: string;
  agentPlansCutoff: string;
  errors: string[];
};

// Best-effort: errors are collected and returned rather than thrown, so a
// prune failure can never fail the forecast write it rides behind.
export async function pruneOldRows(
  client: SupabaseClient,
  now: Date = new Date(),
): Promise<PruneResult> {
  const forecastsCutoff = new Date(
    now.getTime() - FORECAST_RETENTION_DAYS * DAY_MS,
  ).toISOString();
  // plan_date is a DATE column, so compare on the date part only.
  const agentPlansCutoff = new Date(
    now.getTime() - AGENT_PLAN_RETENTION_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);

  const errors: string[] = [];

  const forecasts = await client
    .from("forecasts")
    .delete()
    .lt("generated_at", forecastsCutoff);
  if (forecasts.error) {
    errors.push(`forecasts: ${forecasts.error.message}`);
  }

  const plans = await client
    .from("agent_plans")
    .delete()
    .lt("plan_date", agentPlansCutoff);
  if (plans.error) {
    errors.push(`agent_plans: ${plans.error.message}`);
  }

  return { forecastsCutoff, agentPlansCutoff, errors };
}
