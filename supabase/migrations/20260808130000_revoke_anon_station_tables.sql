-- =============================================================================
-- Migration 0014 — Revoke anon access to per-station tables (PR 2/2)
--
-- Completes the aggregate-only data-layer lockdown started in migration 0013.
-- Every anon read path now goes through security-definer functions that
-- return only aggregates/scalars, so the anon role no longer needs — and no
-- longer has — any direct access to the per-station tables.
--
-- MUST NOT be merged until the migration-0013 app code (PR 1/2) is live on
-- Vercel: old app code reads these tables directly with the anon key, and
-- Supabase applies migrations on merge while Vercel deploys in parallel —
-- revoking first would briefly break every anon read and trip the staleness
-- gate into the maintenance page.
--
-- Belt-and-braces in both layers, matching the house pattern from
-- migrations 0011/0012: drop the RLS policy (RLS-with-no-policy denies) AND
-- revoke the table grant, so access never depends on one mechanism alone.
-- =============================================================================

drop policy if exists "Public read access" on sites;
drop policy if exists "Public read access" on price_snapshots;

revoke select on sites from anon;
revoke select on price_snapshots from anon;

-- Unchanged, deliberately: `forecasts` and `daily_narrative` keep their anon
-- SELECT — they are the aggregate display tables and ARE the public surface.
-- service_role grants on all tables are untouched (the ingest/forecast crons
-- write through service_role, which bypasses RLS).

comment on table sites is
  'QLD fuel sites (denormalised brand/suburb/state), refreshed weekly. '
  'Internal-only since migration 0014: used to scope aggregates; anon reads '
  'go through security-definer RPCs, never this table.';

comment on table price_snapshots is
  'Per-station price events (CSV backfill + 30-min live ingest). '
  'Internal-only since migration 0014: the public surface is aggregate-only; '
  'anon reads go through security-definer RPCs, never this table.';
