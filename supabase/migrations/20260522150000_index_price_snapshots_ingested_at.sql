-- =============================================================================
-- Migration 0005 — Index price_snapshots(ingested_at desc)
--
-- The root layout's freshness check runs
--   select ingested_at from price_snapshots
--   order by ingested_at desc limit 1
-- on every render. The existing indexes on price_snapshots cover
-- (fuel_id, transaction_date_utc) and (site_id, fuel_id, transaction_date_utc
-- desc) — neither helps this query. Without a dedicated index on
-- ingested_at, the query becomes a full table scan once backfill +
-- ongoing snapshots push the row count past trivial sizes.
-- =============================================================================

create index if not exists price_snapshots_ingested_at_idx
  on price_snapshots (ingested_at desc);
