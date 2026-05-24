-- =============================================================================
-- Migration 0007 — Restructure forecasts to match the aggregate grain
--
-- Migration 0002 pivoted price_snapshots from the live API's integer fuel_id to
-- the CSV's textual fuel_name, and left this note:
--
--   "forecasts and daily_narrative still reference fuel_id + geo_region columns
--    and are restructured in a later migration when we wire forecast generation
--    (Phase 2 chunk 4)."
--
-- This is that migration. The forecast we actually generate is a single
-- Brisbane-wide aggregate for one fuel (U91 / "Unleaded"), so the per-fuel-id /
-- per-geo-region key from migration 0001 never applied. We pivot to the same
-- grain the rest of the pipeline speaks:
--
--   fuel_id (int)                      -> fuel_name (text, e.g. "Unleaded")
--   geo_region_level + geo_region_id   -> region (text, e.g. "brisbane_metro")
--
-- The table has never been written (get_forecast returns status='unavailable'
-- until this lands), so the column swap is safe. New columns are added with a
-- temporary default purely so the statement is robust if any row ever existed;
-- the default is dropped immediately after.
--
-- Access model unchanged: anon SELECT, service_role writes (the daily cron).
-- =============================================================================

alter table forecasts drop constraint forecasts_pkey;
drop index if exists forecasts_recent_idx;

alter table forecasts drop column fuel_id;
alter table forecasts drop column geo_region_level;
alter table forecasts drop column geo_region_id;

alter table forecasts add column fuel_name text not null default 'Unleaded';
alter table forecasts add column region    text not null default 'brisbane_metro';
alter table forecasts alter column fuel_name drop default;
alter table forecasts alter column region    drop default;

alter table forecasts
  add constraint forecasts_pkey
  primary key (forecast_for_date, fuel_name, region, generated_at);

create index forecasts_recent_idx
  on forecasts (fuel_name, region, generated_at desc);

comment on column forecasts.fuel_name is
  'Canonical textual fuel name, matching price_snapshots.fuel_name (e.g. "Unleaded"). MVP writes "Unleaded" only.';

comment on column forecasts.region is
  'Aggregate region label for this forecast. MVP writes "brisbane_metro" (postcode 4000-4179, QLD) — the grain of brisbane_daily_avg_u91.';

-- Belt-and-braces grants (per CLAUDE.md): the table-level grants from migration
-- 0004 persist across column changes, but we re-affirm explicitly here since
-- "Automatically expose new tables" is OFF and default privileges only cover
-- tables created by the role that ran the ALTER.
grant select on forecasts to anon;
grant all    on forecasts to service_role;
