-- =============================================================================
-- Migration 0002 — Make schema CSV-backfill-compatible
--
-- The QLD open-data CSV (data.qld.gov.au, CC BY 4.0) uses textual fuel-type
-- names ("Unleaded", "Diesel", "e10") and does not expose the live API's
-- integer Fuel_Type_ID. The CSV also includes denormalised station fields
-- (Site_Brand as text, suburb, state) that we want preserved so we can
-- ingest history without depending on the live API's reference data.
--
-- Changes:
--   - price_snapshots: drop fuel_id, add fuel_name (text, becomes part of PK),
--     add data_source (csv_backfill | live_api).
--   - sites: add brand_name, suburb, state (denormalised text fields).
--
-- forecasts and daily_narrative still reference fuel_id + geo_region columns
-- and are restructured in a later migration when we wire forecast generation
-- (Phase 2 chunk 4).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- price_snapshots: pivot from fuel_id to fuel_name
-- -----------------------------------------------------------------------------

alter table price_snapshots drop constraint price_snapshots_pkey;
drop index if exists price_snapshots_fuel_date_idx;
drop index if exists price_snapshots_site_fuel_recent_idx;
alter table price_snapshots drop column fuel_id;

alter table price_snapshots add column fuel_name text not null;
alter table price_snapshots add column data_source text not null default 'live_api';

alter table price_snapshots
  add constraint price_snapshots_pkey
  primary key (site_id, fuel_name, transaction_date_utc);

create index price_snapshots_fuel_date_idx
  on price_snapshots (fuel_name, transaction_date_utc);

create index price_snapshots_site_fuel_recent_idx
  on price_snapshots (site_id, fuel_name, transaction_date_utc desc);

create index price_snapshots_data_source_idx
  on price_snapshots (data_source);

comment on column price_snapshots.fuel_name is
  'Canonical textual fuel name (e.g. "Unleaded", "Diesel", "e10"). The CSV and the live API both expose this; fuel_id from the live API is intentionally not stored — name is the value we filter and group by.';

comment on column price_snapshots.data_source is
  'Origin of this row. One of: csv_backfill | live_api. Lets us reason about data provenance and back out a source if needed.';


-- -----------------------------------------------------------------------------
-- sites: add denormalised brand/suburb/state from CSV
-- -----------------------------------------------------------------------------

alter table sites add column brand_name text;
alter table sites add column suburb text;
alter table sites add column state text;

comment on column sites.brand_name is
  'Brand as a text label (e.g. "BP", "7 Eleven"). Populated by CSV directly; the live API populates both brand_id and (via a join to brands.name) this column. Use brand_name for display.';

comment on column sites.suburb is
  'Site suburb as published in the CSV. Useful for Brisbane Metro filtering when geo_region IDs (g1..g5) are not yet populated.';

comment on column sites.state is
  'Site state (e.g. "QLD"). Useful as a sanity guard on Brisbane-only queries.';
