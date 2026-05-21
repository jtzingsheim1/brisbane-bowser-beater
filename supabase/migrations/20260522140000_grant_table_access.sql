-- =============================================================================
-- Migration 0004 — Grant table access to anon and service_role
--
-- The Supabase project's "Automatically expose new tables" setting is OFF
-- (a deliberate choice for explicit Data API control). Without that, tables
-- created via migration don't get auto-granted to the PostgREST API roles —
-- so even the service_role hits "permission denied" (Postgres SQLSTATE
-- 42501) until we GRANT explicitly here.
--
-- RLS still governs what anon can SELECT — these GRANTs just allow the role
-- to attempt access in the first place. service_role bypasses RLS by design
-- but, like every Postgres role, still needs the underlying table GRANT.
-- =============================================================================

grant usage on schema public to anon, service_role;

grant select on sites             to anon;
grant all    on sites             to service_role;

grant select on price_snapshots   to anon;
grant all    on price_snapshots   to service_role;

grant select on forecasts         to anon;
grant all    on forecasts         to service_role;

grant select on daily_narrative   to anon;
grant all    on daily_narrative   to service_role;

-- Default privileges for future tables in this schema, so we don't have to
-- remember to GRANT explicitly in every new migration. (Note: only takes
-- effect for tables created by the role that runs this statement.)

alter default privileges in schema public
  grant select on tables to anon;

alter default privileges in schema public
  grant all on tables to service_role;

alter default privileges in schema public
  grant usage, select on sequences to service_role;
