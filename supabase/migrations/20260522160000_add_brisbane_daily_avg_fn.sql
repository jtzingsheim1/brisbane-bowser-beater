-- =============================================================================
-- Migration 0006 — Brisbane daily U91 aggregate function
--
-- Adds `brisbane_daily_avg_u91(start_date, end_date)`: for each day in the
-- range, returns the cross-station average of the *standing* U91 price across
-- core Brisbane Metro sites.
--
-- "Standing" means carry-forward: the QLD open-data CSV is changes-only, so
-- on any given day many stations did not emit an event. We need each
-- station's most-recent-known price as of that day, not just the prices that
-- changed that day. Averaging only changed-events produces a heavily biased
-- estimator (cycle change-days dominate, flat days disappear). The function
-- does a lateral lookup per (day, site) for the latest event on or before
-- that day, then averages across sites.
--
-- Region definition is a working default pending validation in the Phase 2
-- notebook: postcode 4000–4179, state = 'QLD'. This is core Brisbane Metro;
-- outer fringe postcodes (Ipswich/Logan/Moreton) are excluded on the
-- hypothesis that the cycle signal is densest in the core. The notebook may
-- revise this; updating the filter is a one-migration change.
--
-- Performance: ~60 days × ~1600 sites = ~100k lateral lookups against
-- price_snapshots_site_fuel_recent_idx (site_id, fuel_name, transaction_date_utc desc).
-- Each lookup is an index seek + limit-1; total runtime is sub-second on
-- backfilled data. The Next.js caller layers `unstable_cache` on top.
--
-- Exposed as RPC (`select brisbane_daily_avg_u91(...)`) to anon for read.
-- =============================================================================

create or replace function brisbane_daily_avg_u91(
  start_date date,
  end_date date
)
returns table (
  day             date,
  avg_price       numeric(8, 3),
  station_count   integer
)
language sql
stable
as $$
  with date_series as (
    select generate_series(start_date, end_date, interval '1 day')::date as day
  ),
  sites_brisbane as (
    select site_id
    from sites
    where state = 'QLD'
      and postcode between '4000' and '4179'
  )
  select
    ds.day,
    avg(latest.price)::numeric(8, 3)  as avg_price,
    count(latest.price)::integer      as station_count
  from date_series ds
  cross join sites_brisbane sb
  left join lateral (
    select price
    from price_snapshots
    where site_id = sb.site_id
      and fuel_name = 'Unleaded'
      and transaction_date_utc < ds.day + interval '1 day'
    order by transaction_date_utc desc
    limit 1
  ) latest on true
  where latest.price is not null
  group by ds.day
  order by ds.day
$$;

comment on function brisbane_daily_avg_u91(date, date) is
  'Daily carry-forward average U91 price across core Brisbane Metro stations '
  '(postcode 4000–4179, QLD). Region filter is a working default pending '
  'Phase 2 notebook validation. See migration 0006 for rationale.';

grant execute on function brisbane_daily_avg_u91(date, date) to anon;
grant execute on function brisbane_daily_avg_u91(date, date) to service_role;
