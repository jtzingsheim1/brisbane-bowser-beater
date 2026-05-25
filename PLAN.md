# Brisbane Bowser Beater — Plan

Architecture and product context live in [`CLAUDE.md`](CLAUDE.md). This file tracks **status, phase plan, and backlog**.

---

## Status

| Phase | Status |
|---|---|
| Phase 0 — Discovery | ✅ Complete |
| Phase 1 — Scaffold | ✅ Complete (Supabase ↔ GitHub integration confirmed via migrations 0001–0006 auto-applying on merge; Vercel hookup deferred to Phase 8) |
| Phase 2 — Data ingestion + forecast model | 🚧 In progress (schema, CSV backfill, `brisbane_daily_avg_u91` aggregate, cycle characterisation → `cycle_params.json`, the TS daily projection → `forecasts` table, chunk-5 figure adoption, the **live 30-min GitHub Actions ingestion**, and the **daily forecast generation** all landed — chart history *and* the forecast line run on current data; remaining: the daily narrative generator) |
| Phase 3 — Static UI | ✅ Complete (chart, daily narrative, cycle education, privacy pane, `/about/data`, maintenance page, and homepage composition all shipped) |
| Phase 4 — Agent layer | 🚧 In progress (API route, two tools, system prompt, streaming chat UI, and 2×2 starter chip grid all shipped; chip copy/tone polish and plan caching still open) |
| Phase 5 — Cost protection + off-switch | ✅ Code complete (off-switch, input caps, max tokens/steps, per-IP rate limit (Upstash, graceful), `CRON_SECRET` on the forecast route, BYO-key header, and `usage_monthly_visitors` LUL 4.8 counting all landed; deploy-time config — Anthropic spend cap, Upstash + `USAGE_SALT` provisioning, env-var placement — happens at Phase 8) |
| Phase 6 — Abuse audit | Pending |
| Phase 7 — Public docs | Pending |
| Phase 8 — Deploy + verify | Pending |
| Phase 9 — Wrap | Pending |

---

## Phase 0 outcomes (signed off)

| Decision | Outcome |
|---|---|
| Project name | Brisbane Bowser Beater |
| Starter chip quadrant | **Flexibility × fill frequency** (4 chips — see CLAUDE.md Agent section) |
| C-cell variant | Road-trip case (deadline pins outcome, prep-fill has flex) handled via system prompt |
| Educational angle | Two-layer: prominent static copy under chart + agent-side awareness in system prompt |
| Privacy/trust pane | 6 bullets near agent input; IP handling deliberately not mentioned |
| Legal hygiene | Forecast/estimate framing + footer disclaimer + README sourcing line |
| Chart library | Recharts |
| Forecast model architecture | 3-stage: one-time Python characterisation → daily TS projection → occasional re-fit |
| Uncertainty bands | Bootstrap from historical variance; fall back to point-only if implementation gets fiddly |
| Analysis language | Python scripts in `/analysis/` (own venv; notebook rejected — poor git diffs); production stays TypeScript |
| Brief lifecycle | Retired — was kickoff context, not a living doc. Captured into CLAUDE.md, PLAN.md, and project memory before deletion. |

**Open task carried into implementation**: chip copy tone polish. Structure is locked, wording is decided at Phase 4.

---

## Build phases

### Phase 1 — Scaffold

| Sub-task | Status |
|---|---|
| Next.js 16 (App Router) + React 19 + TypeScript strict | ✅ Verified via `npm run build` |
| Tailwind v4 | ✅ Done (added during scaffold) |
| GitHub remote at `jtzingsheim1/brisbane-bowser-beater` (public) | ✅ Done |
| Supabase project (RLS auto-enable on, Data API auto-expose off) | ✅ Done |
| `.env.local` populated (publishable URL + publishable key + secret key) | ✅ Verified via `npm run verify:supabase` |
| `@supabase/supabase-js` client factories in `src/lib/supabase/server.ts` | ✅ Done |
| Supabase CLI as dev dep + `supabase/` folder scaffolded | ✅ Done |
| Supabase ↔ GitHub integration enabled in dashboard | ✅ Confirmed — migrations 0001–0006 have all auto-applied on merge to `main` |
| First migration | ✅ Done (migration 0001 + five follow-ups; see `supabase/migrations/`) |
| Vercel project hookup + env vars | **Deferred to Phase 8** (not blocking dev work) |

**Connectivity check after env changes:**

```bash
npm run verify:supabase
```

Exercises both publishable and secret keys against the data API. Never prints key values. Local-only check — independent of the GitHub integration deploy pipeline.

### Phase 2 — Data ingestion + forecast model

> **Expect a collaborative deep-dive here.** Justin has flagged interest in nerding out on the forecast model design together. Don't speed through this phase — pause for interactive discussion at: (a) raw data shape findings, (b) cycle parameterisation method choice, (c) outlier exclusion rules, (d) projection algorithm. Methods follow what the data reveals; no method choices locked in advance.

> **Phase 2 is the biggest phase** — break execution into chunks rather than trying to land it in one stretch. Chunks: (1) ingestion pipeline + cron + Supabase schema ✅ [schema + CSV backfill + live 30-min GitHub Actions cron], (2) Python data exploration ✅, (3) cycle characterisation + `cycle_params.json` output ✅, (4) TS daily projection writing to `forecasts` table ✅, (5) adopt measured cycle figures into UI/agent copy ✅ (merged #23). Each is a sensible commit/checkpoint.
>
> **Checkpoint decisions taken (chunks 2–3):** detrend via centered rolling median (55d); trough/peak detection via `scipy.find_peaks` (prominence $0.08, distance 18d); cycles trough-to-trough; outlier rule = exclude period > 55d (missed-trough merges); **shape + period recency-weighted (12-month half-life), amplitude equal-weighted** — chosen after a per-cycle trend test showed real but modest drift (shortening period, steepening decline; stable amplitude) rather than the amplitude change a normalised-shape plot first suggested.

- **Register as a publisher** at [fuelpricesqld.com.au](https://www.fuelpricesqld.com.au) (one-time; Justin to do). Accept the publisher LUL; receive a security token by email; paste into `.env.local` as `QLD_FUEL_API_TOKEN`. API spec saved at `docs/external/qld_fuel_api_swagger.json`. Full obligations breakdown lives in CLAUDE.md "Legal hygiene → Publisher licence (QLD LUL) obligations".
- **Schema** — `sites`, `price_snapshots`, `forecasts`, `daily_narrative`. RLS enabled on all tables with anon SELECT policies; writes only via service_role. Under the aggregate-only pivot, `sites` is internal-only (used to filter aggregates) and not displayed. Vestigial reference tables (`fuels`, `brands`, `geo_regions`) from migration 0001 were dropped in migration 0003 — they weren't needed by any MVP query or current backlog feature; re-create by migration if a future need emerges.
- **Historical backfill** (one-time): import the QLD open-data CSV (CC BY 4.0) from [data.qld.gov.au/dataset/fuel-price-reporting-2026](https://www.data.qld.gov.au/dataset/fuel-price-reporting-2026) into `price_snapshots` so the chart works from day 1. CSV currently has Jan + Feb 2026; updates monthly. **Run via `npm run backfill:csv` — already executed once on 2026-05-22 (Jan + Feb 2026 imported: 1,642 sites, 97,230 price events, 22,488 of them `Unleaded`). Re-run when new monthly CSVs land at data.qld.gov.au; the script is idempotent.**
- ✅ **30-min cron via GitHub Actions** (free for public repos — keeps Vercel Hobby tier clean and satisfies LUL 2.3) — **landed**:
  - `scripts/ingest-prices.mjs` (`.github/workflows/ingest-prices.yml`, cron `*/30`) hits `/Price/GetSitesPrices` for the Brisbane L2 region, narrows to core-Brisbane U91, upserts into `price_snapshots` as `live_api`. Writes straight to Supabase via `service_role` — never touches Vercel.
  - `scripts/refresh-sites.mjs` (`refresh-sites.yml`, weekly) refreshes `sites` (brand/postcode/suburb/state/location) from `GetFullSiteDetails` + brand/region reference data.
  - Discovered API constants live in `scripts/lib/qld-api.mjs`: `countryId=21`, Brisbane query region `geoRegionLevel=2`/`geoRegionId=1` (folds in Gold Coast — narrowed by postcode downstream), `FuelId 2 = Unleaded`, price ÷1000 → $/L, sentinel `9999` dropped. **"Brisbane" stays postcode-defined (4000–4179)** to match `brisbane_daily_avg_u91` and the analysis exactly.
  - **Freshness bump**: every run stamps `ingested_at=now()` on the current snapshot, so `MAX(ingested_at)` advances each 30 min even with no price changes — the 60-min staleness gate stays green without `touch-freshness.mjs` (now dev-only).
  - **Requires three GitHub repo secrets**: `QLD_FUEL_API_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
  - ✅ Daily `forecasts` regeneration scheduled — `scripts/generate-forecast.ts` (`generate-forecast.yml`, daily) reuses the production projection (`src/lib/forecast`) via `tsx`, reads the Brisbane aggregate from Supabase, writes a fresh batch. The Vercel route `/api/cron/forecast` shares the same lib, so they can't drift. The projection now trims flat carry-forward dead-zones before fitting, so the backfill→live gap (and any future cron outage) can't corrupt the phase/swing fit.
  - ⏳ `daily_narrative` generation still pending — the line under the chart reads a fallback string until a daily generator lands.
- ✅ **Python scripts `/analysis/*.py`** (own venv; pulls CSVs offline, not via Supabase — deep history doesn't belong in the production DB):
  - `download_data.py` caches ~35 months of QLD CSVs (2023–2026) via the CKAN API
  - `cycle_lib.py` builds the Brisbane core-Metro U91 carry-forward daily series, matching the production aggregate exactly
  - `cycle_fit.py` detrends, detects troughs/peaks, parameterises, builds the canonical shape + by-year cross-check
  - `trend_check.py` regresses per-cycle metrics vs time (drift test)
  - `build_params.py` recency-weighted finalisation → `output/cycle_params.json` + model-vs-history overlay
  - **Measured**: period ~39d, swing ~$0.35, peak ~38% into cycle; shape-fit RMS ~17% of swing. Exploratory PNGs gitignored; `cycle_params.json` committed.
- ✅ TS daily projection (`src/lib/forecast/`) — **chunk 4, landed**:
  - Reads `cycle_params.json` (`params.ts`, validated against schema_version)
  - `project.ts` detects cycle position by a least-squares phase fit over ~1
    cycle of recent observed Brisbane aggregate, then projects ~30 days forward
    on the canonical shape. Anchor level pinned to the trailing observed price
    (clean chart join); swing guarded to 0.5–2× the characterised amplitude as
    a backstop. Uncertainty bands from the characterised per-phase spread.
  - `/api/cron/forecast` writes a batch via `service_role` (CRON_SECRET-guarded
    when set; `?dry=1` returns the projection without writing). Migration 0007
    restructured `forecasts` to the aggregate grain (fuel_name + region).
  - Chart's dashed line + band and the agent's `get_forecast` light up
    automatically once a batch is written (post-merge, when 0007 applies).
- ⏳ **Adopt measured cycle figures into user-facing UI / agent copy** (chunk 5). CLAUDE.md cycle section already updated with the verified, observation-only numbers; propagating into chart copy + agent system prompt is the remaining step, under the same language discipline.
- Default daily narrative line generated daily, cached for the day

### Phase 3 — Static UI

- ✅ Chart component (Recharts) — single Brisbane aggregate line with historical + forecast + uncertainty band slot. History window anchors to the most-recent observed event so the carry-forward function doesn't paint a flat tail when the live cron isn't running.
- ✅ Static cycle education copy under chart
- ✅ Daily narrative line below chart — reads `daily_narrative` table with a fallback string until the daily generator lands (Phase 2)
- ✅ Privacy/trust pane placed near agent input
- ✅ **`/about/data` page** carrying the verbatim QLD attribution notices (LUL clauses 4.2 + 4.3). Linked from the footer.
- ✅ **Maintenance / kill-switch page** for staleness or `BBB_PUBLIC=false` — see Phase 5
- ~~Station list with postcode input + per-row exclude control~~ — cut from MVP (see CLAUDE.md "Section 2 — cut from MVP")

### Phase 4 — Agent layer

- ✅ API route at `src/app/api/agent/route.ts` using Vercel AI SDK v6 + `@ai-sdk/anthropic` (Sonnet 4.6). Returns 503 with a clear message when `ANTHROPIC_API_KEY` is unset.
- ✅ Two tools: `get_forecast`, `get_recent_history`. `get_today_spread` was dropped along with Section 2. `get_forecast` returns `status: "unavailable"` until the forecasts table is populated.
- ✅ System prompt at `src/lib/agent/system-prompt.ts` encoding cycle context, role, chip-cell awareness (incl. C-cell road-trip variant), educational nudges, defamation-aware language constraints, and results-first interaction shape. **Cycle figures still qualitative pending Phase 2 measured values.**
- ✅ Streaming response with visible tool calls — chat UI at `src/components/AgentChat.tsx` (2×2 starter chip grid + textbox + message list + inline tool-call markers)
- ✅ **Starter chip grid** — 4 chips in a 2×2 quadrant (flexibility × frequency). Each chip clicks into a conversational kick-off message that identifies the cell (A/B/C/D). Chips hide after the first message. **Open polish item**: chip copy/tone — edit the `CHIPS` array at the top of `AgentChat.tsx`.
- ⏳ Plan output cached per `(situation_hash, day)` in Supabase — needs a small migration; deferred until after first end-to-end agent smoke test

### Phase 5 — Cost protection + operational off-switch (build all)

Cost protection:
- ⏳ `ANTHROPIC_API_KEY` as Vercel env var only — never in repo, client, or logs (Phase 8 when Vercel hookup lands; local `.env.local` is the dev path)
- ⏳ Hard daily spend cap set manually in Anthropic console
- ✅ Per-IP rate limit via Upstash Redis — `src/lib/rate-limit.ts` (sliding window, 10/60s on the agent route). Graceful no-op until `UPSTASH_REDIS_REST_*` are provisioned (Vercel marketplace, Phase 8).
- ⏳ Aggressive caching of repeatable queries — partially landed (`unstable_cache` on freshness + aggregates + narrative); agent plan caching pending under Phase 4
- ✅ `CRON_SECRET` for cron endpoint protection — the Vercel forecast route (`/api/cron/forecast`) honours a Bearer `CRON_SECRET` when set (open when unset, for local dev). The GitHub Actions ingest/forecast jobs write straight to Supabase and don't traverse this route.
- ✅ Max tokens cap on every Anthropic call (1500 in `src/app/api/agent/route.ts`)
- ✅ Max agent iterations cap (6 steps via `stopWhen: stepCountIs(6)`)
- ✅ Strict input validation in the agent route — 20-message cap, 16k-char total cap, JSON parse guard
- ✅ BYO-key scaffolding — the agent route accepts an `x-anthropic-key` header that overrides the server key (no UI exposure); the caller then pays for their own usage.

Operational off-switch (see CLAUDE.md "Operational hygiene"):
- ✅ **Staleness check on render** — every page reads the latest `price_snapshots.ingested_at`; if older than 60 min, render a "Data temporarily unavailable" page instead of chart/agent. Auto-degradation when cron fails.
- ✅ **`BBB_PUBLIC` env var kill switch** — when unset, whole app renders "currently paused" page. Flip in Vercel dashboard for instant takedown.
- ✅ **Server-side aggregate usage counts** — per LUL clause 4.8. `recordVisit()` (`src/lib/usage.ts`) writes one row per (month, salted-IP-hash, region) to `usage_monthly_visitors` (migration 0009), fired post-response from the homepage via `after()`. No raw IP, no cookies, internal-only (no anon SELECT). No-op until `USAGE_SALT` is set. Privacy/trust pane stays literally true.

### Phase 6 — Abuse audit (mandatory before deploy)

Enumerate every cost-blowup vector and verify each defence. Categories (non-exhaustive):

- Rate-limit bypass via rotating IPs / VPN / proxy
- Cache bypass via random query parameters
- Prompt injection driving runaway token output
- Infinite agent loops (tool call → tool call → ...)
- Direct API endpoint hits bypassing the UI
- Cron endpoint abuse
- Log leakage of the API key
- Long-input attacks (massive context stuffing)
- Multi-tab or scripted hitting of the per-visitor agent

Add more vectors as discovered. Document each defence. Confirm before deploy.

### Phase 7 — Public docs

- `README.md`:
  - Product overview
  - Brisbane cycle education (sourced from CLAUDE.md content; rewritten in user-facing voice)
  - How to use
  - How the forecast works (methodology + bands explanation)
  - Cost + operational architecture (off-switch, staleness check, kill switch)
  - Roadmap (what's deliberately out of scope, what's planned)
  - Contributing
  - Data sourcing line crediting QLD government as publisher under LUL + CC BY 4.0 historical CSV
- `/about/data` page in the app — verbatim QLD attribution notices (LUL 4.2 + 4.3), the CC BY 4.0 attribution for the backfill CSV, and an honest plain-English data flow ("we poll every 30 min, aggregate, never store per-station prices for display").
- All public artifacts scrubbed of motivation/career framing (see project memory)
- Bake cycle education into both README and any user-facing UI copy

### Phase 8 — Deploy + verify

- Deploy to Vercel
- Verify env vars set correctly
- Verify rate limiting fires after configured threshold
- Verify Anthropic spend cap set
- Verify cron job runs and updates Supabase
- End-to-end smoke test: load page → see chart + narrative → trigger agent plan generation → verify streaming + cache
- Verify staleness check fires correctly (simulate stale snapshot)
- Verify `BBB_PUBLIC=false` flips the whole app to paused page

### Phase 9 — Wrap

- Confirm deploy URL and GitHub repo URL
- 2-line summary for use elsewhere
- If `fuel_app_brief.md` somehow still exists in the working directory, add to `.gitignore` (or delete) before first commit

---

## Likely next-session entry points

When picking up cold, the most useful chunks to consider — roughly ordered by visible payoff per effort:

1. **Smoke-test the agent end-to-end.** Drop `ANTHROPIC_API_KEY` into `.env.local`, run `npm run dev`, open `/`, pick a chip or describe a situation. Verify streaming + visible tool calls + the language-constraint behaviour (try an accusatory prompt and confirm the graceful redirect). If `ingested_at` is older than 60 min, re-run `npm run backfill:csv` first to push freshness back inside the staleness window. No code required.
2. **Polish chip copy/tone.** First-cut copy is in `CHIPS` at the top of `src/components/AgentChat.tsx`. Each chip has a `label`, `hint`, and `kickoff` message — open work is purely wording. Worth doing after the smoke-test so you can feel how each chip lands in conversation.
3. **Phase 4 plan caching by `(situation_hash, day)`.** Migration adds an `agent_plans` table; route hashes the input situation pre-stream, returns cached output if hit, writes after stream completes. ~45 min, autonomous; defer until after entry 1 since blind streaming + caching is awkward to get right without a working agent to verify against.
4. **Populate the `forecasts` table (post-merge of chunk 4).** Migration 0007 auto-applies on merge to `main`; then hit `GET /api/cron/forecast` once (locally via `npm run dev` against the migrated DB, or on the deploy) to write the first batch. The chart's dashed line + band and the agent's `get_forecast` light up immediately (both already wired). `?dry=1` previews the projection without writing. **(Chunks 2–4 are ✅ done — exploration, characterisation, and the TS projection in `src/lib/forecast/`.)**
5. **Phase 2 chunk 5 — adopt measured figures into UI/agent copy.** CLAUDE.md already carries the verified numbers (period ~39d, swing ~$0.35, peak ~38% in). Propagate into chart copy + agent system prompt, observation-only.
6. **Phase 5 cost protection layers** — per-IP rate limit via Upstash Redis, `CRON_SECRET`, BYO-key header, `usage_aggregates` table. Off-switch + per-call caps already landed; this is the remaining defensive surface. Mostly autonomous.
7. ✅ **Phase 2 chunk 1.5 — live 30-min cron.** GitHub Actions ingest + weekly sites refresh, writing straight to Supabase. **Landed** — the chart now runs on current Brisbane data. Needs the three GitHub repo secrets set to run in CI (see the chunk-1 bullet above).
8. ✅ **Daily forecast regeneration scheduled** — `generate-forecast.yml` runs `scripts/generate-forecast.ts` daily (reuses the production projection via tsx). The remaining piece is the **daily narrative generator** (the text line under the chart, still a fallback string) — it can ride the same daily cadence once built.

Open external blocker: **none** — the QLD publisher token has been received and the live cron is in. Deploy (Phase 8) is the remaining gate to having the cron run on schedule in the cloud (locally/CI it already works).

---

## Backlog (post-MVP)

Items deliberately deferred — track here so they're not lost:

- **Section 2: per-station price list with postcode search** — cut from MVP for the publisher-licence-exposure reason. Re-evaluate post-launch if/when we want to expand surface area; would need verbatim per-station attribution + 30-min freshness against the per-station feed, plus station-level UX (postcode search, exclude controls, etc.).

- **Postcode-level price summary** — first candidate to pull forward post-MVP. When a user enters a postcode, show an additional summary panel: average price for that postcode, comparison to Brisbane-wide median, and/or top-10% cheapest stations across nearby suburbs. Adds spatial price awareness ("is my area generally cheap?") on top of the per-station list. **Needs fleshing out before implementation**: definition of "nearby suburbs" (radius vs adjacent postcodes vs geographic clusters), how to handle edge cases (small postcodes, city-edge postcodes, postcodes with few stations), whether it sits above or beside the station list, whether it's collapsed by default. Discuss with Justin before building.
- **5th "explain the cycle" starter chip** — opt-in path for cycle-unfamiliar users who want to learn before engaging
- **Long-form privacy page** — only if ever needed; current 6-bullet pane covers MVP needs
- **Browser geolocation** — eliminates postcode-entry friction
- **Map UI** — replaces or supplements the station list
- **Push notifications / "on the move" alerts** — the killer long-term feature; requires PWA + Service Workers + Web Push + background geo + mobile UI rebuild
- **User accounts / favourites** — for when personalisation deepens
- **Multiple fuel types beyond U91**
- **Multiple regions beyond Brisbane Metro**
- **Interactive historical price charts** — drill into past cycles
- **Quarterly cycle parameter re-fit** — Stage 3 of the forecast model architecture; document drift over time
- **Real-time push from fuel API** — replace cron-pulled snapshot if the API ever supports it
