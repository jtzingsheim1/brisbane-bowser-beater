# Data refresh — March + May 2026 CSV backfill + live-API seam bridge

**Date:** 2026-06-03
**Issue:** #47 (PR-2 + PR-3, combined PR)
**Operator:** local Claude / @jtzingsheim1

The QLD open-data portal published March 2026 and May 2026 monthly CSVs. This refresh imports both and bridges the seam between the May CSV and the live-API ramp, closing the chart's multi-span deadzone and starting the post-anomaly forecast anchor.

After this refresh, **all ongoing data is live-API only** — no further monthly CSV interleaves needed.

---

## 1. liveStartDay determination

`scripts/probe-live-coverage.mjs` (pre-import probe, 2026-06-03) showed core-Brisbane (QLD postcode 4000–4179, 392 sites; 80% threshold = 314) cumulative-distinct live-API site coverage:

| day | cum. sites | % | crossed 80%? |
|---|---|---|---|
| 2026-05-06 | 2 | 0.5% | |
| 2026-05-11 | 3 | 0.8% | |
| 2026-05-15 | 30 | 7.7% | |
| 2026-05-18 | 98 | 25.0% | |
| 2026-05-21 | 168 | 42.9% | |
| 2026-05-22 | 182 | 46.4% | |
| 2026-05-23 | 193 | 49.2% | |
| **2026-05-24** | **334** | **85.2%** | **yes** |
| 2026-05-25 | 360 | 91.8% | yes |
| 2026-05-26 | 362 | 92.3% | yes |
| … | | | |

**`liveStartDay = 2026-05-24`** — a clean one-day jump from 49% to 85% coverage. CSV owns days *before* this; live owns from this day onward.

---

## 2. Cutover delete + import

`node --env-file=.env.local scripts/backfill-csv.mjs --cutover` (2026-06-03):

| step | rows |
|---|---|
| Cutover delete (live_api U91, `transaction_date_utc < 2026-05-24`) | 193 deleted |
| January 2026 CSV upsert | 63,488 price events, 1,571 unique sites |
| February 2026 CSV upsert | 33,742 price events, 1,471 unique sites |
| **March 2026 CSV upsert** (new) | **115,689 price events, 1,763 unique sites** |
| April 2026 CSV upsert | 115,490 price events, 1,763 unique sites |
| **May 2026 CSV upsert** (new, clipped) | **43,756 price events kept, 12,801 dropped by `clipBeforeDay=2026-05-24`** |

January/February/April rows are idempotent re-upserts — no double-count.

---

## 3. PK-collision check

`scripts/verify-seam.mjs` (2026-06-03):

```
PK collision probe (U91, across data_source)...
  scanned 80,662 U91 rows
  cross-source collision keys: 0
```

The CSV/live timestamp-precision difference would have shown up as duplicated `(site_id, transaction_date_utc)` keys with different `data_source` values. **None found** — the clipBeforeDay strategy works as designed.

---

## 4. Discontinuity check (±3 days around liveStartDay)

Brisbane core-Metro U91 daily mean via `brisbane_daily_avg_u91` RPC (the production aggregate):

| day | avg_price | stations | day-over-day |
|---|---|---|---|
| 2026-05-21 | $1.936 | 367 | — |
| 2026-05-22 | $1.932 | 367 | -$0.004 |
| 2026-05-23 | $1.929 | 367 | -$0.003 |
| **2026-05-24 *(seam)*** | **$1.930** | **367** | **+$0.001** |
| 2026-05-25 | $1.929 | 367 | -$0.001 |
| 2026-05-26 | $1.898 | 367 | -$0.031 |
| 2026-05-27 | $1.888 | 367 | -$0.010 |

The cutover at 2026-05-24 is +$0.001/day — glass-smooth. The biggest day-over-day move in the window (-$0.031 on 2026-05-26) is well below the $0.05 investigation gate and well *after* the seam, not a seam artifact. **Ship.**

---

## 5. Deadzone gate adjustment

A subtle interaction surfaced post-import: `liveCoverageRampEnd` in `src/lib/aggregates.ts` measures cumulative-distinct live-API site coverage, which restarts from scratch after the cutover delete (the bulk-load rows that previously bridged ramp coverage were deleted). The post-delete probe shows coverage taking until 2026-05-28 to re-cross 80%, so the heuristic would paint a sticky 4-day deadzone band (2026-05-24 → 2026-05-27) that doesn't naturally clear.

**Fix:** gate the `rampEnd` extension on whether there's an actual calendar gap between CSV and live. When CSV covers right up to the day before live's first day (the seam-cutover case), CSV-side carry-forward handles the early-ramp days adequately and no band is honest.

Code change: `src/lib/aggregates.ts:317-329` — `if (calendarGap)` guard around the `rampEnd` extension. Cache key bumped to v4 to invalidate stale spans.

---

## 6. Acceptance checks against issue #47

- [x] Chart shows continuous Brisbane core-Metro U91 history from Jan 2026 → live data with no deadzone bands visible. *(Confirmed via the deadzone math: `lastBackfillDay = 2026-05-23`, `firstLiveDay = 2026-05-24`, no calendar gap, `rampEnd` extension skipped, `start > end` → no span pushed.)*
- [x] `price_snapshots` has zero rows where the same `(site_id, fuel_name)` is duplicated across `csv_backfill` and `live_api`. *(0 collisions, section 3.)*
- [x] `cycle_params.json` includes `anomaly_notes` documenting the Feb–Apr 2026 window and `post_anomaly_anchor_date: "2026-05-01"` with rationale.
- [x] Production forecast stays preliminary until the most-recent observed day is ≥ `post_anomaly_anchor_date`, then re-anchors on observed prices from that date. *(Implemented in `src/lib/forecast/project.ts`; covered by 3 new tests in `project.test.ts`.)*
- [x] `npm run build` green; `npx eslint .` green; Vitest suite green.
- [x] This file records the import run + seam-bridge results.
