# Brisbane Bowser Beater — Plan

Architecture and product context live in [`CLAUDE.md`](CLAUDE.md). This file tracks **status, phase plan, and backlog**.

---

## Status

| Phase | Status |
|---|---|
| Phase 0 — Discovery | ✅ Complete |
| Phase 1 — Scaffold | ✅ Complete (Supabase ↔ GitHub integration confirmed via migrations auto-applying on merge; Vercel hookup deferred to Phase 8) |
| Phase 2 — Data ingestion + forecast model | ✅ Complete (schema, CSV backfill, `brisbane_daily_avg_u91` aggregate, cycle characterisation → `cycle_params.json`, TS daily projection, chunk-5 figure adoption, live 30-min GitHub Actions ingestion, daily forecast generation, and the daily narrative generator all landed — the chart, forecast line, and narrative all run on current data) |
| Phase 3 — Static UI | ✅ Complete (chart, daily narrative, cycle education, privacy pane, `/about/data`, maintenance page, and homepage composition all shipped) |
| Phase 4 — Agent layer | ✅ Complete (API route, two tools, system prompt, streaming chat UI, 2×2 starter chip grid, chip copy polish, and plan caching by `(situation_hash, day)` all shipped) |
| Phase 5 — Cost protection + off-switch | ✅ Complete (off-switch, input caps, max tokens/steps, per-IP rate limit (Upstash, graceful), `CRON_SECRET` on the forecast route, BYO-key header, and `usage_monthly_visitors` LUL 4.8 counting all landed; deploy-time config — Anthropic spend cap, Upstash + `USAGE_SALT` provisioning, env-var placement — wired up at Phase 8) |
| Phase 6 — Abuse audit | ✅ Complete (`docs/abuse-audit.md` — every cost/abuse vector enumerated with its defence + a pre-deploy checklist) |
| Phase 7 — Public docs | ✅ Complete (README rewritten in public voice; `/about/data` attribution page shipped in Phase 3) |
| Phase 8 — Deploy + verify | ✅ Complete (live at https://brisbane-bowser-beater.vercel.app; Vercel project + Upstash Marketplace integration + all secrets provisioned; defence stack verified live — rate-limit 429, cron 401, agent guardrail, kill-switch toggle, paused/live page rendering) |
| Phase 9 — Wrap | ✅ Complete (post-launch audit landed via PR #46; the March + May 2026 CSV backfill follow-ups closed out via PR #49 / issue #47. Remaining audit items are parked below — none gating.) |
| Post-launch — "Shout me a litre" tip jar (Stripe) | 🚧 Built 2026-07-21 (Stripe-hosted Checkout, signature-verified webhook → PII-free `tip_ledger`, flag-gated behind `BBB_TIPS`). Awaiting go-live: live keys + webhook registration + flag flip — see deploy-runbook §6. |

---

## Post-launch audit follow-ups (parked)

Six specialist reviewers (security, deployment-config / architect, database, code-quality, refactor-cleaner, docs+tests) plus direct GitHub-state checks audited the codebase + deployment on 2026-05-28 right after Phase 8 went live. Overall verdict: ship-quality. The quick wins landed in **PR #46** (doc drift, dead-code, HSTS, `BBB_STALENESS_MINUTES` clamp). Everything below was deliberately parked — not blocking, but recorded so the audit work isn't lost.

Severity columns reflect the audit lanes' own ratings. Effort: S = minutes, M = ~1 hr, L = several hours.

### Worth doing soon (S effort, real-but-small risks)

- **`CRON_SECRET` timing-safe comparison.** `src/app/api/cron/forecast/route.ts:22` uses plain `===` against the bearer token. Replace with `crypto.timingSafeEqual` on fixed-length `Buffer`s (~3 lines + import). Theoretical timing-oracle attack only — bounded blast radius (idempotent DB writes, no LLM spend), but the fix is trivial. (Security lane, Low.)
- **Add `analyze` (CodeQL) as a required branch-protection check on `main`.** Currently only `check` is required, so CodeQL runs on PRs but doesn't block merges. One click in repo settings → Branches → branch protection rule. (Direct GitHub-state check.)
- **Dependabot postcss alert (GHSA-qx2v-qp2m-jg93, medium).** Transitive dep via Next.js, build-time only, no user CSS in the pipeline → no practical impact. Don't `npm audit fix --force` (would downgrade Next). Leave open until Next.js publishes a patched release; re-check after each Next 16.x bump.
- **Architect 30-item dashboard verification checklist (beyond the 7-item shortlist Justin walked).** The lower-blast-radius items are still worth glancing at when time allows (e.g. V13 production-branch=main, V15 deployment-protection off, S5/S6 Supabase project not paused, A6 no orphaned dev Anthropic keys). Full list lived in the audit lane output (this transcript) — also re-derivable by re-running the architect agent against the codebase.

### Growth-cliff / structural (M effort each, weeks-to-months horizon)

- **`liveCoverageRampEnd` rewrite to SQL aggregation.** *Independently flagged by code-quality (High) and database (Medium) lanes.* `src/lib/aggregates.ts:212–242` fetches every `data_source='live_api'` row into Node and walks them client-side to find the day 80% of stations were live-reporting. Safe today (small live data) but becomes expensive *and* algorithmically wrong as data accumulates — sites with backdated `transaction_date_utc` can trigger an early threshold-cross. Correct shape: a single per-day SQL aggregation that returns one date. Also cache with `unstable_cache`.
- **`brisbane_daily_avg_u91` hardening.** Two one-migration fixes: (a) add `SET search_path = public, pg_catalog` to the function signature (schema-injection defence-in-depth, even though anon has no DDL); (b) add a date-range guard at the top of the body (`if end_date - start_date > 365 then raise`) so an anon caller can't request 2000–2099. (Database lane, Medium ×2.)
- **`forecasts` covering index.** As the table grows, the latest-batch lookup will heap-fetch ~30 rows per request. `CREATE INDEX forecasts_batch_covering_idx ON forecasts (fuel_name, region, generated_at DESC) INCLUDE (forecast_for_date, predicted_price, band_low, band_high);` — supersedes the current `forecasts_recent_idx`. (Database lane, Medium.)

### Critical-path test gaps (mostly S each)

The current Vitest suite (38 tests across 5 files as of 2026-06-05) covers deterministic forecast logic + CSV header normalisation + low-level CSV helpers, but skips the cost / licence / privacy surfaces. **The two biggest code changes shipped on 2026-05-28 (freshness + rate-limit) still have zero direct tests.** Priority order (highest first):

1. **`freshness.ts` env-parse + clamp**. New `BBB_STALENESS_MINUTES` path (default 60 → valid positive override → invalid `NaN`/`0`/negative/empty → fallback → `>1440` → clamp). Off-switch / LUL gate; one regression flips the site live or paused unintentionally.
2. **`rate-limit.ts` env resolution**. `UPSTASH_*` set wins, `KV_*` set, both set (UPSTASH wins), neither set → null limiter. Today's KV_* fallback is the highest-risk change of the day. Requires `vi.resetModules` + dynamic import (module-level memoisation).
3. **Cron route `authorized()` matrix**: secret unset → open, header missing → 401, wrong scheme → 401, correct `Bearer X` → ok. Extract to exported helper for testability.
4. **Agent route input validation**: empty messages, >20 messages, >16k char total, malformed JSON, malformed `x-anthropic-key` shape. The cost-bounding promises in `docs/abuse-audit.md` live entirely in these branches.
5. **`usage.getClientIp` header precedence**: `x-vercel-forwarded-for` > `x-real-ip` > `x-forwarded-for`, comma-split, trim. Privacy-pane claim relies on this; spoofable-header ordering matters.
6. **`forecast/params.validate`**: schema_version mismatch, mismatched array lengths, non-positive `period_days`/`amplitude_dollars`/`peak_phase` (also add a `peak_phase ∈ [0,1]` check — `params.ts:26-29` is missing it).
7. **Install `@vitest/coverage-v8`** so `npm test -- --coverage` works — unblocks future quantitative tracking.

### Backlog / consider later (mostly Low / nit)

- **Content Security Policy header** in `next.config.ts`. XSS surface is narrow today (`react-markdown` uses React elements, no `dangerouslySetInnerHTML`, no user-supplied HTML), but CSP is best-practice defence-in-depth. Starter policy in security-lane finding 4. M effort to do right (with proper Tailwind/Next handling).
- **Plan-cache `hashSituation` drops tool-call detail.** `src/lib/agent/plan-cache.ts:20-23` maps non-text parts to a `[tool-call]` placeholder, so two multi-turn conversations differing only in tool calls hash the same. False-positive risk for multi-turn cache hits (intended hot path is first-turn chip kickoffs, which are unaffected). Either include tool details in the canonical string, or document the scope narrowing in a code comment.
- **`cachedPlanResponse` transparency.** Cache-hit replays emit a single text blob with no tool-call activity chips, so a user sees no signal distinguishing a live response from a cached one — slight honesty gap vs the "visible tool calls" transparency story. Either add a `*(Using a saved plan from earlier today)*` prefix, or note caching in the privacy pane copy. (Code-quality, Medium UX.)
- **Supabase client singleton.** `src/lib/supabase/server.ts` creates a fresh client per call; on a cold-start render with cache miss, up to five new clients are constructed. Switch to module-level lazy singleton.
- **`AgentChat.tsx:247` uses array-index keys** for streaming message parts. Stable today (streaming only appends), brittle to future part-ordering changes. Use a stable key like `${p.type}-${i}`.
- **`forecasts` retention policy.** ~10,800 rows/year accumulating with no purge. Document growth in a comment and add a quarterly `DELETE WHERE generated_at < now() - interval '6 months'` step. (Database lane, Low.)
- **`agent_plans` retention.** Similar shape — ~20k chars per row × cache-hit count over time. Add `DELETE FROM agent_plans WHERE plan_date < current_date - 30` as a cron step. (Database lane, Nit.)
- **`usage_monthly_visitors.visitor_hash` `CHECK (length = 32)`** + update column comment to note 128-bit truncation (vs the comment's implied 256-bit). One-migration nit. (Database lane, Nit.)
- **Consolidate `readEnv` + `batchUpsert` in `scripts/backfill-csv.mjs`** with the versions in `scripts/lib/qld-api.mjs`. Currently duplicated — `backfill-csv.mjs` was self-contained from before `qld-api.mjs` was extracted. (Refactor-cleaner, investigate-before-removing.)
- **In-place mutation in `mergeSpans`** at `src/lib/aggregates.ts:299` (`last.end = s.end`). Local copy, no caller-visible effect, but conflicts with the immutability preference in CLAUDE.md. Replace with `merged[merged.length - 1] = { ...last, end: s.end }`. (Code-quality, Low.)
- **`getClientIp` comment**: clarify that fallbacks (`x-real-ip`, `x-forwarded-for`) are client-spoofable and only used in non-Vercel envs. (Security lane, Low.)
- **`backfill-csv.mjs` `parseDateUtc` doesn't validate calendar dates** (e.g. accepts `32/01/2026`). One-shot script against a government CSV, very low real risk. (Now lives in `scripts/lib/csv-backfill.mjs` after the PR #48 extract.) Round-trip validate or skip-with-warning. (Code-quality, Low.)

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

Chip copy tone polish was the one open Phase 0 carry-in; landed in Phase 4 (`CHIPS` in `src/components/AgentChat.tsx`).

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
| Supabase ↔ GitHub integration enabled in dashboard | ✅ Confirmed — migrations have all auto-applied on merge to `main` (0001 through 0011) |
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
  - ✅ `daily_narrative` generation landed — `src/lib/forecast/narrative.ts` (pure, observation-only) composes the line from the projection; the daily job writes it alongside the forecast. Migration 0008 restructured `daily_narrative` to the `fuel_name`/`region` grain (matching 0007).
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
- ✅ **Adopt measured cycle figures into user-facing UI / agent copy** (chunk 5) — landed in PR #23. The verified, observation-only numbers (period ~39d, swing ~$0.35, peak ~38% in) propagated into the chart's cycle-education copy and the agent system prompt, under the same language discipline.
- Default daily narrative line generated daily, cached for the day

### Phase 3 — Static UI

- ✅ Chart component (Recharts) — single Brisbane aggregate line with historical + forecast + uncertainty band slot. History window anchors to the most-recent observed event so the carry-forward function doesn't paint a flat tail when the live cron isn't running.
- ✅ Static cycle education copy under chart
- ✅ Daily narrative line below chart — reads `daily_narrative` (filtered to U91/brisbane_metro), generated daily by the forecast job; fallback string only if the table is empty
- ✅ Privacy/trust pane placed near agent input
- ✅ **`/about/data` page** carrying the verbatim QLD attribution notices (LUL clauses 4.2 + 4.3). Linked from the footer.
- ✅ **Maintenance / kill-switch page** for staleness or `BBB_PUBLIC=false` — see Phase 5
- ~~Station list with postcode input + per-row exclude control~~ — cut from MVP (see CLAUDE.md "Section 2 — cut from MVP")

### Phase 4 — Agent layer

- ✅ API route at `src/app/api/agent/route.ts` using Vercel AI SDK v6 + `@ai-sdk/anthropic` (Sonnet 4.6). Returns 503 with a clear message when `ANTHROPIC_API_KEY` is unset.
- ✅ Two tools: `get_forecast`, `get_recent_history`. `get_today_spread` was dropped along with Section 2. `get_forecast` returns `status: "unavailable"` until the forecasts table is populated.
- ✅ System prompt at `src/lib/agent/system-prompt.ts` encoding cycle context, role, chip-cell awareness (incl. C-cell road-trip variant), educational nudges, defamation-aware language constraints, and results-first interaction shape. Cycle figures are the measured values from `cycle_params.json` (adopted in chunk 5).
- ✅ Streaming response with visible tool calls — chat UI at `src/components/AgentChat.tsx` (2×2 starter chip grid + textbox + message list + inline tool-call markers)
- ✅ **Starter chip grid** — 4 chips in a 2×2 quadrant (flexibility × frequency). Each chip clicks into a conversational kick-off message that identifies the cell (A/B/C/D). Chips hide after the first message. Chip copy/tone polished.
- ✅ Plan output cached per `(situation_hash, day)` — `src/lib/agent/plan-cache.ts` + migration 0010 (`agent_plans`). The route replays a cached plan on hit (no Anthropic call) and caches on finish; cache failures fall back to a live call. Internal table (no anon access).

### Phase 5 — Cost protection + operational off-switch (build all)

Cost protection:
- ⏳ `ANTHROPIC_API_KEY` as Vercel env var only — never in repo, client, or logs (Phase 8 when Vercel hookup lands; local `.env.local` is the dev path)
- ⏳ Hard daily spend cap set manually in Anthropic console
- ✅ Per-IP rate limit via Upstash Redis — `src/lib/rate-limit.ts` (sliding window, 10/60s on the agent route). Reads either `UPSTASH_REDIS_REST_*` (native) or `KV_REST_API_*` (the env vars Vercel's Upstash Marketplace integration actually injects — added in PR #44). Graceful no-op when neither is set.
- ✅ Aggressive caching of repeatable queries — `unstable_cache` on freshness + aggregates + narrative, plus agent plan caching (`agent_plans`, Phase 4).
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

Closed out via PR #46 (post-launch audit + hardening) and PR #49 (issue #47 backfill follow-ups). Remaining work is in the parked audit list above; nothing gating.

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
- **Staleness-cap the daily average (data quality — feeds chart AND forecast)** — the RPC (`brisbane_daily_avg_u91`) carry-forwards each station's last-known price indefinitely. Two problems: (1) during the backfill→live ramp-up, days are dominated by stale Feb prices until enough stations report — handled *cosmetically* today by the coverage-threshold deadzone (option A, ~80% cutoff landed ~24 May); (2) a **suspended/closed station** keeps contributing its frozen last price to the average forever — a small (~0.25%/station) but **permanent, accumulating** skew that the coverage filter can't catch (the station *did* report once). Fix (option B): exclude a station's price from a day's average when its latest price is older than ~N days (suggest ~21, under the cycle length), so the average reflects only currently-active stations and the forecast gets clean input. **Forecast caveat:** with a staleness cap applied *today* we'd have <`MIN_FIT_POINTS` (7) real days, so `projectForecast` would correctly return null until ~2 weeks of live coverage accrue — so the forecast pipeline should read the same staleness-capped history and the UI keeps the "forecast preliminary" state until then. Requires an RPC migration + re-validating the forecast pipeline. Until then the forecast is fit partly on the coverage-ramp artifact (the 13–23 May gradual "decline" is mostly stations flipping from stale to live, not real price movement): level anchoring is sound, cycle-phase anchoring is not.
<!-- Backlog item "Generalise chart deadzone to any data gap" landed via PR #42:
     `detectFlatRuns` in src/lib/aggregates.ts catches any ≥5-day flat run and
     `mergeSpans` returns multiple bands; the backfill→live transition is now
     just one input to the same pipeline. Removed from backlog 2026-06-05. -->
