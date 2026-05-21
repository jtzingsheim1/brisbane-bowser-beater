-- =============================================================================
-- Migration 0003 — Drop vestigial reference tables
--
-- Originally created in migration 0001 expecting the live QLD API's integer
-- IDs to be the canonical identifiers. The CSV-backfill pivot (migration
-- 0002) moved canonical fuel identification to text (fuel_name) and pushed
-- brand display data into sites.brand_name. No MVP query or current backlog
-- feature joins these tables.
--
-- Re-creating them is a one-migration affair if a future feature needs them
-- (Section 2 station list, multi-fuel selector, multi-region selector).
-- =============================================================================

drop policy if exists "Public read access" on fuels;
drop policy if exists "Public read access" on brands;
drop policy if exists "Public read access" on geo_regions;

drop table if exists fuels;
drop table if exists brands;
drop table if exists geo_regions;
