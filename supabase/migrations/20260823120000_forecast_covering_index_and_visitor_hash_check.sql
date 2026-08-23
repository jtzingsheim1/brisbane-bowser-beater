-- =============================================================================
-- Parked audit items, database lane (PLAN.md "Post-launch audit follow-ups"):
--
-- 1. forecasts covering index. The hot read is "latest batch for
--    (fuel_name, region)" — ~30 rows per cache miss. The old
--    forecasts_recent_idx located the rows but every column still came from
--    heap fetches; INCLUDE carries the full row shape in the index leaf so
--    the lookup stays index-only as the table grows. (Growth is also now
--    capped: the daily forecast cron prunes rows older than ~6 months.)
--
-- 2. usage_monthly_visitors.visitor_hash integrity CHECK + honest comment.
--    The app stores HMAC-SHA256(USAGE_SALT, ip) truncated to 32 hex chars
--    (128 bits) — the original inline comment implied a full 256-bit digest.
--    Existing rows all satisfy the CHECK (the writer has sliced to 32 chars
--    since launch).
--
-- Access model unchanged: no new tables, so no new grants needed (index and
-- constraint changes ride the existing table grants).
-- =============================================================================

create index forecasts_batch_covering_idx
  on forecasts (fuel_name, region, generated_at desc)
  include (forecast_for_date, predicted_price, band_low, band_high);

drop index if exists forecasts_recent_idx;

alter table usage_monthly_visitors
  add constraint usage_monthly_visitors_hash_len
  check (length(visitor_hash) = 32);

comment on column usage_monthly_visitors.visitor_hash is
  'HMAC-SHA256(USAGE_SALT, client IP) truncated to 32 hex chars (128 bits). No raw IP is ever stored.';
