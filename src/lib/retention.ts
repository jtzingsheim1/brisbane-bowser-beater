import type { SupabaseClient } from "@supabase/supabase-js";

// Row retention for the tables that would otherwise grow without bound:
// `forecasts` (~30 rows/day, one batch per generation), `agent_plans` (the
// per-(situation, day) plan cache) and `usage_monthly_visitors` (one salted
// visitor hash per visitor per month, src/lib/usage.ts).
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
// Visitor hashes exist only for the licence's clause 4.8 usage reporting
// (active, new and returning users per month). Thirteen calendar months, the
// current one included, covers a year-on-year report plus "returning" against
// the month before; older months are dropped so a recurring hash can't build
// a long visit history. The /privacy page states this period.
export const USAGE_RETENTION_MONTHS = 13;

const DAY_MS = 86_400_000;

export type PruneResult = {
  forecastsCutoff: string;
  agentPlansCutoff: string;
  usageCutoff: string;
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

  // period_month is the first day of a month; keep the current month and the
  // USAGE_RETENTION_MONTHS - 1 before it.
  const usageCutoff = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - (USAGE_RETENTION_MONTHS - 1),
      1,
    ),
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

  const usage = await client
    .from("usage_monthly_visitors")
    .delete()
    .lt("period_month", usageCutoff);
  if (usage.error) {
    errors.push(`usage_monthly_visitors: ${usage.error.message}`);
  }

  return { forecastsCutoff, agentPlansCutoff, usageCutoff, errors };
}
