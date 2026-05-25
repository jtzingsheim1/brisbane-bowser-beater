-- =============================================================================
-- Migration 0009 — Usage aggregates for QLD LUL clause 4.8
--
-- The licence requires us to report active / new / returning users per month
-- with a region split, on request within 10 business days. This table is the
-- source for that report.
--
-- Privacy posture (reconciles with the privacy/trust pane):
--   - No cookies, no client JS, no per-user identity.
--   - No raw IP is ever stored. visitor_hash = HMAC-SHA256(USAGE_SALT, ip),
--     irreversible and rotatable. One row per (month, visitor).
--   - new-vs-returning is derived by comparing months at report time.
--
-- INTERNAL-ONLY: unlike the display tables, this is deliberately NOT readable by
-- anon. RLS is enabled with no anon policy (so anon is denied), and we grant
-- only service_role. This is an intentional deviation from the usual
-- "grant select to anon" convention in CLAUDE.md.
-- =============================================================================

create table usage_monthly_visitors (
  period_month  date not null,         -- first day of the month (YYYY-MM-01)
  visitor_hash  text not null,         -- HMAC-SHA256(USAGE_SALT, ip), truncated
  region        text,                  -- coarse region from edge geo headers, or 'unknown'
  first_seen    timestamptz not null default now(),
  primary key (period_month, visitor_hash)
);

create index usage_monthly_visitors_month_idx
  on usage_monthly_visitors (period_month);

alter table usage_monthly_visitors enable row level security;
-- No anon policy on purpose: usage data is internal, not part of the public
-- surface. anon gets no SELECT; service_role bypasses RLS and is granted below.
grant all on usage_monthly_visitors to service_role;

comment on table usage_monthly_visitors is
  'LUL 4.8 usage reporting. One row per (month, salted-IP-hash). No raw IPs, no '
  'cookies; internal-only (no anon access). visitor_hash = HMAC-SHA256(USAGE_SALT, ip).';
