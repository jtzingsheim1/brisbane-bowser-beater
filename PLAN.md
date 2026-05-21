# Brisbane Bowser Beater — Plan

Architecture and product context live in [`CLAUDE.md`](CLAUDE.md). This file tracks **status, phase plan, and backlog**.

---

## Status

| Phase | Status |
|---|---|
| Phase 0 — Discovery | ✅ Complete |
| Phase 1 — Scaffold | 🔜 Next |
| Phase 2 — Data ingestion + forecast model | Pending |
| Phase 3 — Static UI | Pending |
| Phase 4 — Agent layer | Pending |
| Phase 5 — Cost protection | Pending |
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
| Analysis language | Python (Jupyter notebook in `/analysis/`); production stays TypeScript |
| Brief lifecycle | Retired — was kickoff context, not a living doc. Captured into CLAUDE.md, PLAN.md, and project memory before deletion. |

**Open task carried into implementation**: chip copy tone polish. Structure is locked, wording is decided at Phase 4.

---

## Build phases

### Phase 1 — Scaffold

- Next.js 16 (App Router) + React 19 + TypeScript strict
- Supabase project created, schema versioned via migrations
- Vercel project connected to GitHub repo, env vars set
- Local dev working

**Deferred sub-task — create GitHub remote** (not needed until Vercel hookup or first backup push):

```bash
gh repo create brisbane-bowser-beater --public --source=. --push --description "A web app for Brisbane drivers, combining live fuel price data with an AI-powered fuel strategist."
```

Creates `jtzingsheim1/brisbane-bowser-beater` (public), wires up `origin`, pushes `main` — one shot. Run whenever ready.

### Phase 2 — Data ingestion + forecast model

> **Expect a collaborative deep-dive here.** Justin has flagged interest in nerding out on the forecast model design together. Don't speed through this phase — pause for interactive discussion at: (a) raw data shape findings, (b) cycle parameterisation method choice, (c) outlier exclusion rules, (d) projection algorithm. Methods follow what the data reveals; no method choices locked in advance.

> **Phase 2 is the biggest phase** — break execution into chunks rather than trying to land it in one stretch. Natural chunks: (1) ingestion pipeline + cron + Supabase schema, (2) Python notebook data exploration, (3) cycle characterisation + `cycle_params.json` output, (4) TS daily projection writing to `forecasts` table, (5) update CLAUDE.md cycle figures from measured values. Each is a sensible commit/checkpoint.

- Integrate QLD Fuel Price Reporting API (free, no auth — https://www.qld.gov.au/transport/projects/fuelprice/data)
- Vercel Cron job (daily, single ingestion run — sufficient for this phase)
- Python notebook `/analysis/brisbane_cycle.ipynb`:
  - Pull max historical data
  - Visualise raw series; characterise actual cycle shape empirically
  - Detect troughs/peaks
  - Parameterise: period, asymmetry (peak-to-trough vs trough-to-peak days), amplitude, peak duration
  - Robust statistics (median + MAD) for parameters; exclude outlier cycles (likely COVID, March 2022 fuel excise cut, anything outside ~2 MAD)
  - Output: `/analysis/output/cycle_params.json` + a normalised cycle shape template
- TS daily projection (`/lib/forecast/`):
  - Reads `cycle_params.json`
  - Detects current cycle position from most recent observed pivot
  - Projects ~30 days forward applying canonical shape, anchored at pivot
  - Writes `forecasts` table in Supabase
- **Update `CLAUDE.md` cycle figures** (period, swing, asymmetry) with measured values once observed
- Default daily narrative line generated during ingestion, cached for the day

### Phase 3 — Static UI

- Chart component (Recharts) with historical + forecast + (stretch) uncertainty bands
- Station list with postcode input + per-row exclude control
- Static cycle education copy under chart
- Daily narrative line below chart
- Privacy/trust pane placed near agent input

### Phase 4 — Agent layer

- API route using Vercel AI SDK v6 + `@ai-sdk/anthropic`
- Three tools: `get_forecast`, `get_recent_history`, `get_today_spread` (see CLAUDE.md)
- System prompt encoding:
  - Brisbane cycle context (with measured figures, not stylised)
  - Agent role (personalised fuel strategist, not free-roaming chatbot)
  - Chip-cell awareness, including C-cell road-trip variant detection
  - Educational nudges for cycle-unfamiliar users
  - **Defamation-aware language constraints** (see CLAUDE.md "Legal hygiene → Language about retailers and pricing"). Encode the safe-list / avoid-list, the prohibition on characterising retailer behaviour as wrongdoing, the prohibition on naming retailers in negative framing, the prohibition on guaranteeing savings figures, and the graceful-decline behaviour if a user tries to steer the agent into accusatory framing.
  - **Results-first interaction shape** (see CLAUDE.md "Agent → Interaction shape"). Agent produces a strategy on the first turn after chip pick, names assumptions, offers refinement. Never leads with an interview.
- Streaming response to UI with visible tool calls
- Plan output cached per `(situation_hash, day)` in Supabase
- **Chip copy finalised** — 4 chips, tone polished

### Phase 5 — Cost protection (build all)

- `ANTHROPIC_API_KEY` as Vercel env var only — never in repo, client, or logs
- Hard daily spend cap set manually in Anthropic console
- Per-IP rate limit via Upstash Redis
- Aggressive caching of repeatable queries
- `CRON_SECRET` for cron endpoint protection
- Max tokens cap on every Anthropic call
- Max agent iterations cap (prevent infinite tool-call loops)
- Strict input validation (length limits, allowed values)
- Code-level BYO-key scaffolding (header override, no UI exposure)

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
  - Cost architecture explanation
  - Roadmap (what's deliberately out of scope, what's planned)
  - Contributing
  - Data sourcing line crediting QLD government open API
- All public artifacts scrubbed of motivation/career framing (see project memory)
- Bake cycle education into both README and any user-facing UI copy

### Phase 8 — Deploy + verify

- Deploy to Vercel
- Verify env vars set correctly
- Verify rate limiting fires after configured threshold
- Verify Anthropic spend cap set
- Verify cron job runs and updates Supabase
- End-to-end smoke test: load page → see chart + narrative → trigger agent plan generation → verify streaming + cache → check station list

### Phase 9 — Wrap

- Confirm deploy URL and GitHub repo URL
- 2-line summary for use elsewhere
- If `fuel_app_brief.md` somehow still exists in the working directory, add to `.gitignore` (or delete) before first commit

---

## Backlog (post-MVP)

Items deliberately deferred — track here so they're not lost:

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
