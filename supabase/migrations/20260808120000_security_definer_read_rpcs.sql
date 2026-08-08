-- =============================================================================
-- Migration 0013 — Security-definer read RPCs (aggregate-only data layer, PR 1/2)
--
-- Why: the product invariant is "no per-station prices anywhere on the public
-- surface" (CLAUDE.md; docs/abuse-audit.md). The display layer honours that,
-- but the DATA layer never caught up with the Section-2 cut: migration 0001
-- (written when a per-station price list was still in scope) gave anon
-- `using (true)` SELECT policies on `sites` and `price_snapshots`, and
-- migration 0004 granted them — partly because `brisbane_daily_avg_u91` runs
-- SECURITY INVOKER, so anon needed direct table access for the RPC to work.
-- Net effect: the anon key (public by design) could read raw per-station rows.
--
-- Fix, in two steps to avoid a deploy/migration race:
--   PR 1 (this migration): make every anon read path go through
--     SECURITY DEFINER functions that return only aggregates/scalars, and
--     flip `brisbane_daily_avg_u91` to definer. Backwards compatible — the
--     table grants stay until the new app code is deployed.
--   PR 2 (follow-up migration): revoke anon's direct SELECT on `sites` and
--     `price_snapshots` and drop their anon RLS policies.
--
-- Also lands two parked audit items (PLAN.md "Growth-cliff / structural"):
--   - `liveCoverageRampEnd` moves from a fetch-every-live-row JS walk to a
--     single SQL aggregation returning one date.
--   - `brisbane_daily_avg_u91` gains `SET search_path` and a range guard.
--
-- All functions here are STABLE, SECURITY DEFINER with a pinned search_path
-- (definer functions must never resolve objects via the caller's path), and
-- EXECUTE is revoked from PUBLIC then granted to anon + service_role only.
-- None of them can return a per-station row: their return types are a daily
-- aggregate table, single timestamps, or a single date.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) brisbane_daily_avg_u91 → SECURITY DEFINER + search_path + range guard
--
-- Body unchanged from migration 0006 apart from the guard: same date series,
-- same core-Metro site filter, same carry-forward lateral. plpgsql now (was
-- sql) purely so the guard can RAISE.
-- -----------------------------------------------------------------------------

create or replace function brisbane_daily_avg_u91(
  start_date date,
  end_date date
)
returns table (
  day             date,
  avg_price       numeric(8, 3),
  station_count   integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Range guard (audit item): anon is rate-limited upstream, but a
  -- pathological range like 2000-01-01..2099-12-31 would do ~36k days of
  -- lateral lookups per call. The app never asks for more than ~120 days.
  if end_date - start_date > 366 then
    raise exception 'date range too large (max 366 days)';
  end if;

  return query
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
  order by ds.day;
end;
$$;

comment on function brisbane_daily_avg_u91(date, date) is
  'Daily carry-forward average U91 price across core Brisbane Metro stations '
  '(postcode 4000–4179, QLD). SECURITY DEFINER since migration 0013 so anon '
  'needs no direct table access; range-guarded to 366 days.';

revoke execute on function brisbane_daily_avg_u91(date, date) from public;
grant execute on function brisbane_daily_avg_u91(date, date) to anon;
grant execute on function brisbane_daily_avg_u91(date, date) to service_role;

-- -----------------------------------------------------------------------------
-- 2) latest_snapshot_ingested_at — freshness gate (src/lib/freshness.ts)
--
-- Replaces anon's `select ingested_at ... order by ... limit 1` on
-- price_snapshots. One timestamp out, nothing else.
-- -----------------------------------------------------------------------------

create or replace function latest_snapshot_ingested_at()
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select max(ingested_at) from price_snapshots;
$$;

comment on function latest_snapshot_ingested_at() is
  'Most recent ingestion timestamp, for the LUL 2.3 staleness gate. '
  'Returns NULL when the table is empty.';

revoke execute on function latest_snapshot_ingested_at() from public;
grant execute on function latest_snapshot_ingested_at() to anon;
grant execute on function latest_snapshot_ingested_at() to service_role;

-- -----------------------------------------------------------------------------
-- 3) snapshot_event_bound — earliest/latest event timestamp
--    (src/lib/aggregates.ts: chart-window anchor + backfill/live seam edges)
--
-- p_source NULL = any source. One timestamp out.
-- -----------------------------------------------------------------------------

create or replace function snapshot_event_bound(
  p_fuel_name text,
  p_source text default null,
  p_earliest boolean default false
)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_earliest then min(transaction_date_utc)
    else max(transaction_date_utc)
  end
  from price_snapshots
  where fuel_name = p_fuel_name
    and (p_source is null or data_source = p_source);
$$;

comment on function snapshot_event_bound(text, text, boolean) is
  'Earliest (p_earliest) or latest event timestamp for a fuel, optionally '
  'filtered to one data_source. Returns NULL when no rows match.';

revoke execute on function snapshot_event_bound(text, text, boolean) from public;
grant execute on function snapshot_event_bound(text, text, boolean) to anon;
grant execute on function snapshot_event_bound(text, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 4) live_coverage_ramp_end — SQL port of the aggregates.ts JS walk
--
-- Semantics preserved exactly from src/lib/aggregates.ts liveCoverageRampEnd:
-- walk live events in time order counting distinct sites; the day the
-- cumulative count first reaches ceil(core_count * threshold) is the first
-- trustworthy day, so the ramp ends the UTC day before. If the threshold is
-- never reached, the ramp extends through the latest live day. NULL when
-- there are no core sites or no live rows.
--
-- "The k-th distinct site appears" happens at that site's FIRST event, so
-- ranking sites by first_seen gives the cumulative-distinct crossing time
-- without scanning every row into the app (the parked audit item).
-- -----------------------------------------------------------------------------

create or replace function live_coverage_ramp_end(
  p_fuel_name text,
  p_threshold numeric default 0.8
)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with core as (
    select count(*)::numeric as n
    from sites
    where state = 'QLD'
      and postcode between '4000' and '4179'
  ),
  firsts as (
    select min(transaction_date_utc) as first_seen
    from price_snapshots
    where fuel_name = p_fuel_name
      and data_source = 'live_api'
    group by site_id
  ),
  ranked as (
    select first_seen, row_number() over (order by first_seen) as rn
    from firsts
  ),
  crossing as (
    select first_seen
    from ranked, core
    where core.n > 0
      and rn >= ceil(core.n * p_threshold)
    order by rn
    limit 1
  )
  select case
    when (select n from core) = 0 then null
    when not exists (select 1 from ranked) then null
    when exists (select 1 from crossing)
      then ((select first_seen from crossing) at time zone 'utc')::date - 1
    else (
      (select max(transaction_date_utc)
       from price_snapshots
       where fuel_name = p_fuel_name
         and data_source = 'live_api') at time zone 'utc'
    )::date
  end;
$$;

comment on function live_coverage_ramp_end(text, numeric) is
  'Last day of the live-ingestion ramp-up during which too few core-Metro '
  'stations had reported for the daily average to be trusted. NULL when '
  'there are no core sites or no live data.';

revoke execute on function live_coverage_ramp_end(text, numeric) from public;
grant execute on function live_coverage_ramp_end(text, numeric) to anon;
grant execute on function live_coverage_ramp_end(text, numeric) to service_role;
