-- =============================================================================
-- Migration 0010 — Agent plan cache
--
-- Caches the fuel-strategist's response per (situation, day), so identical
-- situations on the same day reuse a plan instead of re-billing Anthropic.
-- In practice the high-value hit is the starter chips: many users click the
-- same chip and send the same default kickoff, which hashes identically.
--
-- Keyed by day because the plan embeds that day's forecast (trough date,
-- prices) — a plan must not outlive the forecast it was built on.
--
-- INTERNAL cache: not part of the public surface. RLS on with no anon policy
-- (anon denied); the agent route reads/writes via service_role.
-- =============================================================================

create table agent_plans (
  situation_hash  text not null,        -- sha256 of the normalised conversation
  plan_date       date not null,        -- UTC day the plan was generated for
  plan_text       text not null,        -- the cached assistant plan
  generated_at    timestamptz not null default now(),
  primary key (situation_hash, plan_date)
);

alter table agent_plans enable row level security;
-- No anon policy on purpose (internal cache). service_role bypasses RLS.
grant all on agent_plans to service_role;

comment on table agent_plans is
  'Per-(situation_hash, day) cache of agent plan text. Cost defence layer 3. '
  'Internal-only (no anon access); read/written by the agent route via service_role.';
