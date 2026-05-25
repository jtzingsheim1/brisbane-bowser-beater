-- =============================================================================
-- Migration 0008 — Restructure daily_narrative to match the aggregate grain
--
-- Companion to migration 0007 (which did the same for forecasts). Migration
-- 0002 left this note:
--
--   "forecasts and daily_narrative still reference fuel_id + geo_region columns
--    and are restructured in a later migration when we wire forecast generation."
--
-- The narrative is a single Brisbane-wide line for one fuel (U91 / "Unleaded"),
-- so the per-fuel-id / per-geo-region key never applied. Pivot to the grain the
-- rest of the pipeline speaks:
--
--   fuel_id (int)                      -> fuel_name (text, e.g. "Unleaded")
--   geo_region_level + geo_region_id   -> region (text, e.g. "brisbane_metro")
--
-- The table has never been written (DailyNarrative renders a fallback string
-- until the generator lands with this PR), so the column swap is safe. New
-- columns get a temporary default purely so the statement is robust if any row
-- ever existed; the default is dropped immediately after.
--
-- Access model unchanged: anon SELECT, service_role writes (the daily cron).
-- =============================================================================

alter table daily_narrative drop constraint daily_narrative_pkey;

alter table daily_narrative drop column fuel_id;
alter table daily_narrative drop column geo_region_level;
alter table daily_narrative drop column geo_region_id;

alter table daily_narrative add column fuel_name text not null default 'Unleaded';
alter table daily_narrative add column region    text not null default 'brisbane_metro';
alter table daily_narrative alter column fuel_name drop default;
alter table daily_narrative alter column region    drop default;

alter table daily_narrative
  add constraint daily_narrative_pkey
  primary key (narrative_date, fuel_name, region);

comment on column daily_narrative.fuel_name is
  'Canonical textual fuel name, matching price_snapshots.fuel_name (e.g. "Unleaded"). MVP writes "Unleaded" only.';

comment on column daily_narrative.region is
  'Aggregate region label for this narrative. MVP writes "brisbane_metro" (postcode 4000-4179, QLD) — the grain of brisbane_daily_avg_u91.';

-- Belt-and-braces grants (per CLAUDE.md): re-affirm explicitly since
-- "Automatically expose new tables" is OFF and default privileges only cover
-- tables created by the role that ran the ALTER.
grant select on daily_narrative to anon;
grant all    on daily_narrative to service_role;
