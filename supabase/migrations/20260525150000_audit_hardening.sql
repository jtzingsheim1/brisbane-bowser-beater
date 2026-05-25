-- =============================================================================
-- Migration 0011 — Audit hardening
--
-- Follow-ups from the pre-deploy audit. All low-risk on the current (small,
-- mostly-empty) tables.
-- =============================================================================

-- 1) Belt-and-braces REVOKE on the internal tables. RLS already denies anon
--    (no policy), but migration 0004's `alter default privileges ... grant
--    select ... to anon` may have conferred a table-level grant to anon on
--    these later tables. Remove it explicitly so access never depends on RLS
--    alone. No-op if the grant was never conferred.
revoke select on usage_monthly_visitors from anon;
revoke select on agent_plans from anon;

-- 2) Drop the never-read data_source index. No query filters on data_source
--    alone; it only adds write overhead to the 30-min ingest.
drop index if exists price_snapshots_data_source_idx;

-- 3) Constrain data_source to the two known origins (catches a future typo at
--    write time). Existing rows are all 'csv_backfill' or 'live_api'.
alter table price_snapshots
  add constraint price_snapshots_data_source_chk
  check (data_source in ('csv_backfill', 'live_api'));

-- 4) Cap cached plan size. agent_plans exists for cost control; unbounded text
--    works against that. A normal plan is well under 20k chars (max output is
--    1500 tokens).
alter table agent_plans
  add constraint agent_plans_plan_text_len_chk
  check (length(plan_text) <= 20000);
