-- =============================================================================
-- Migration 0001 — Core fuel data schema
--
-- Establishes the data model for ingested fuel-price data from the QLD Fuel
-- Price Reporting API (fuelpricesqld.com.au) and the project's derived
-- artefacts (forecasts, daily narrative).
--
-- Tables created:
--   fuels            reference: FuelId → name
--   brands           reference: BrandId → name
--   geo_regions      reference: hierarchical geographic regions
--   sites            fuel station details (refreshed weekly via cron)
--   price_snapshots  per-(site, fuel) prices captured each day by cron
--   forecasts        daily-generated 30-day projected average prices
--   daily_narrative  cached daily summary line displayed below the chart
--
-- Access model:
--   RLS is enabled on every table. Anon role gets SELECT on all tables
--   (this is open public data). All writes are restricted to the service_role
--   key (used by the daily Vercel cron); no anon write policies exist, so
--   anon is locked out of inserts/updates/deletes by default.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Reference tables
-- -----------------------------------------------------------------------------

create table fuels (
  fuel_id      integer primary key,
  name         text not null,
  ingested_at  timestamptz not null default now()
);

create table brands (
  brand_id     integer primary key,
  name         text not null,
  ingested_at  timestamptz not null default now()
);

create table geo_regions (
  geo_region_level  integer not null,
  geo_region_id     integer not null,
  name              text not null,
  abbrev            text,
  parent_id         integer,
  ingested_at       timestamptz not null default now(),
  primary key (geo_region_level, geo_region_id)
);


-- -----------------------------------------------------------------------------
-- Sites (fuel stations)
--
-- API field map (PascalCase → snake_case):
--   S → site_id, A → address, N → name, B → brand_id, P → postcode,
--   G1..G5 → g1..g5 (geo_region_id at level 1..5 for this site),
--   Lat/Lng → lat/lng, M → last_modified_at,
--   GPI/MO/MC/TO/TC/.../SUO/SUC → consolidated into `hours` JSONB.
-- -----------------------------------------------------------------------------

create table sites (
  site_id           integer primary key,
  brand_id          integer,
  name              text not null,
  address           text not null,
  postcode          text,
  lat               double precision,
  lng               double precision,
  g1                integer,
  g2                integer,
  g3                integer,
  g4                integer,
  g5                integer,
  hours             jsonb,
  last_modified_at  timestamptz,
  ingested_at       timestamptz not null default now()
);

create index sites_postcode_idx on sites (postcode);
create index sites_g3_idx on sites (g3);  -- metro-level filter for Brisbane Metro


-- -----------------------------------------------------------------------------
-- Price snapshots
--
-- One row per (site, fuel) per ingestion run. The cron writes a new batch
-- each day. PK on (site_id, fuel_id, transaction_date_utc) lets the same
-- site/fuel pair appear once per moment-in-time the API reports.
-- -----------------------------------------------------------------------------

create table price_snapshots (
  site_id               integer not null,
  fuel_id               integer not null,
  price                 numeric(8, 3) not null,
  collection_method     text,
  transaction_date_utc  timestamptz not null,
  ingested_at           timestamptz not null default now(),
  primary key (site_id, fuel_id, transaction_date_utc)
);

create index price_snapshots_fuel_date_idx
  on price_snapshots (fuel_id, transaction_date_utc);

create index price_snapshots_site_fuel_recent_idx
  on price_snapshots (site_id, fuel_id, transaction_date_utc desc);


-- -----------------------------------------------------------------------------
-- Forecasts
--
-- Daily-generated 30-day-ahead projections. Each cron run inserts a fresh
-- batch tagged with `generated_at`. Old forecasts are retained so we can
-- retrospectively measure forecast accuracy.
-- -----------------------------------------------------------------------------

create table forecasts (
  forecast_for_date  date not null,         -- date being forecast
  fuel_id            integer not null,
  geo_region_level   integer not null,
  geo_region_id      integer not null,
  generated_at       timestamptz not null,  -- when this forecast was made
  predicted_price    numeric(8, 3) not null,
  band_low           numeric(8, 3),
  band_high          numeric(8, 3),
  primary key (forecast_for_date, fuel_id, geo_region_level, geo_region_id, generated_at)
);

create index forecasts_recent_idx
  on forecasts (fuel_id, geo_region_level, geo_region_id, generated_at desc);


-- -----------------------------------------------------------------------------
-- Daily narrative
--
-- Pre-computed daily summary line ("Brisbane is mid-cycle peak; next trough
-- expected ~Tue 28th…") displayed below the chart. One row per (day, fuel,
-- region) tuple.
-- -----------------------------------------------------------------------------

create table daily_narrative (
  narrative_date    date not null,
  fuel_id           integer not null,
  geo_region_level  integer not null,
  geo_region_id     integer not null,
  narrative_text    text not null,
  generated_at      timestamptz not null default now(),
  primary key (narrative_date, fuel_id, geo_region_level, geo_region_id)
);


-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- All data here is public; anon gets SELECT on every table. No write
-- policies are defined for anon, which means anon is denied INSERT / UPDATE /
-- DELETE by default. The service_role bypasses RLS entirely.
-- -----------------------------------------------------------------------------

alter table fuels             enable row level security;
alter table brands            enable row level security;
alter table geo_regions       enable row level security;
alter table sites             enable row level security;
alter table price_snapshots   enable row level security;
alter table forecasts         enable row level security;
alter table daily_narrative   enable row level security;

create policy "Public read access" on fuels             for select to anon using (true);
create policy "Public read access" on brands            for select to anon using (true);
create policy "Public read access" on geo_regions       for select to anon using (true);
create policy "Public read access" on sites             for select to anon using (true);
create policy "Public read access" on price_snapshots   for select to anon using (true);
create policy "Public read access" on forecasts         for select to anon using (true);
create policy "Public read access" on daily_narrative   for select to anon using (true);
