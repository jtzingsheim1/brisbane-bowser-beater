# Brisbane Bowser Beater

A single-page web app for Brisbane drivers, combining live fuel price data with an AI-powered fuel strategist agent. Helps consumers time and locate their fills around Brisbane's pronounced artificial retail fuel price cycle.

---

## Brisbane fuel cycle (essential context)

Australian retail fuel prices in major capital cities exhibit recurring cycles that have been studied by the ACCC, which publishes regular [fuel and petrol monitoring reports](https://www.accc.gov.au/by-industry/petrol-and-fuel/fuel-and-petrol-monitoring). The cycles are not closely correlated with wholesale price movements. The specific characteristics of the **current** Brisbane cycle — period, amplitude, asymmetry, shape, regularity, typical station spread — are what this project's Phase 2 characterisation measures from QLD Fuel Price Reporting API data.

**No quantitative claims here until Phase 2 lands.** This section is deliberately qualitative. After Phase 2 produces a measured characterisation, this section gets updated with verified numbers, and the user-facing UI / agent narratives can adopt them.

**Equally important — language discipline (defamation-aware).** See "Legal hygiene → Language about retailers and pricing" below. The cycle is an observation; the project does not characterise retailer behaviour as wrongdoing, and language across all surfaces must respect that. Australian defamation law is plaintiff-friendly and well-resourced retail fuel companies would not respond favourably to a tool that frames their behaviour as wrongdoing.

In the interim (and ongoing):
- Public-facing UI and the agent describe the cycle in **qualitative AND observation-only terms** (e.g., *"Brisbane prices move in recurring cycles; we forecast where they're going"*) — no causal characterisation of retailer behaviour.
- Avoid specific period, swing, or comparison claims until they're measured.
- The chart itself implicitly shows the magnitudes once it's populated — let the data speak.

**Tone**: confident and useful, with light humour where it lands, never preachy. **Avoid editorialising** about the cycle or about retailer behaviour — the safe-list / avoid-list in the Legal hygiene section governs language across every surface in this project.

---

## Product

Single page. One section + agent layer. Aggregate-only display — **no per-station prices** anywhere on the public surface.

### Section 1 — "When to fill up"

- **Chart**: ~90-day window of **Brisbane area average** U91 price (~60 days history from CC BY backfill + ongoing daily aggregates from live API + ~30 days forecast). Recharts. Single line — never per-station.
- **Static educational copy below the chart** explaining the cycle — always visible, for first-time visitors.
- **Daily narrative line** (generated daily, cached). Example: *"Brisbane is mid-cycle peak; next trough expected ~Tue 28th. Fill now only if you're nearly empty."*
- **AI fuel strategist agent** (see Agent section below).

### Section 2 — cut from MVP

Per-station ("where to fill up right now") was originally planned but has been **cut from MVP** for two reasons:

1. Per-station display materially expands our publisher-licence exposure (every station's price would need verbatim attribution + 30-min freshness against the per-station feed).
2. The differentiated value of this project — the cycle awareness and the agent strategy — lives in Section 1. Per-station lookups are already well-served by PetrolSpy, 7-Eleven Fuel, etc.

Captured in the backlog for post-MVP re-evaluation.

### Page-wide UI elements

These appear on every page:

- **Privacy/trust pane** — positioned near agent input. Content described in Agent section below.
- **Footer disclaimer** — *"General information only. Fuel prices and forecasts are estimates — verify before you fill."* See Legal hygiene section.
- **`/about/data` page** linked from footer — carries the verbatim QLD attribution notices required by the publisher licence (LUL clauses 4.2 / 4.3).
- **Maintenance / kill-switch page** — see "Operational hygiene → off-switch" below. Rendered automatically when data is stale or manually when paused.

---

## Agent — fuel strategist

**Role**: personalised fuel strategy generator, not a free-roaming chatbot. The UI shape reflects this (purposeful inputs/outputs, not a centre-of-page chatbox).

The agent is free to reference the chart in its reasoning and answer chart-related questions naturally if asked. No backend filters block chart-adjacent questions — constraint comes from UI shape and system prompt.

### Starter chip quadrant — flexibility × fill frequency

| | **Locked in** | **Has wiggle room** |
|---|---|---|
| **Frequent (≥ weekly)** | A: Routine commuter, same fills every week | B: Frequent filler with options to shift |
| **Infrequent (< weekly)** | C: Light driver, tight constraints when fuel is needed | D: Light driver with lots of slack |

What the agent does in each cell:
- **A**: Optimise within tight constraints. Shift the weekly fill day by 1–2 days; advise which weeks to grit teeth and pay peak.
- **B**: Bigger strategic moves — skip weeks, stagger across cars, lean on WFH days.
- **C**: Single high-stakes fill ahead. Nail the timing and the station.
- **D**: Full optimisation — agent essentially designs the user's cycle.

**Cell C also covers the road-trip variant**: deadline pins the *outcome* (full tank by date X), but the *prep-fill timing* still has flex. System prompt should help the agent recognise and handle both variants of cell C.

### Interaction shape — results first, refine second

**The agent never leads with an interview.** Each chip provides enough context for a useful first-cut strategy using sensible defaults (e.g., median Brisbane commuter assumptions). On the very first turn after a chip is picked, the agent:

1. **Produces a strategy** — best-effort given the chip and default assumptions
2. **Names the assumptions** it relied on — explicitly, so the user can see what's being defaulted
3. **Offers refinement** — closes with *"I can sharpen this if you tell me [tank size, weekly km, current level, WFH pattern, detour tolerance, vehicle count]"*

The user decides whether to engage further or take the first answer and run. Subsequent turns refine — but every turn (including the first) outputs a usable strategy unless the user explicitly asks the agent to just gather info first.

This is materially better UX than the alternative ("AI asks 20 questions before producing anything") and demonstrates the agent's value immediately.

Chip copy is finalised during Phase 4 implementation — structure is locked, wording is open.

### Educational angle — two-layer

1. **Static prominent copy under the chart** — always visible, sets context for first-time visitors who don't know the cycle exists.
2. **Agent-side awareness** in the system prompt — agent gauges cycle-familiarity from user's wording and inlines a one-liner when useful. Not robotic, contextual.

### Privacy / trust pane (near agent input)

Six bullets, plain language, lightly cheeky. Positioned so users see it *before* engaging the agent:

- No account, no login. Nothing here is tied to who you are.
- We don't store your conversation. It goes to Anthropic to generate your plan, then it's gone on our side. (Anthropic's terms apply to their bit.)
- No tracking, no analytics, no cookies that follow you around.
- Caching is anonymous. Same situation gets the same plan — we hash the inputs, we don't keep them.
- Only the planner is AI. The station ranking and forecast chart are deterministic.
- It's all on GitHub. Don't trust this list? Read the code.

IP handling is deliberately not mentioned (server-side IPs are a normal infra concern, not this pane's job — including them would draw attention to something users wouldn't otherwise think about).

### Agent tools

| Tool | Purpose |
|---|---|
| `get_forecast()` | Today's cached forecast — cycle position, predicted next trough date, confidence, typical cycle length |
| `get_recent_history(days)` | Brisbane area daily aggregate averages for context |

Two tools, not three — `get_today_spread()` was dropped along with Section 2 because per-station spread isn't part of the public surface anymore.

Agent decides which to call, in what order, based on user's situation. Streaming visible to the user (visible tool calls). Plan output cached per `(situation_hash, day)` in Supabase.

### Output shape

Concrete, dated, with reasoning. Example:

> *"Based on your weekly fill pattern, current half-tank, and our cycle forecast: your next 3 fills should be **Tue 28th (~$1.69)**, **Wed 7th May (~$1.71)**, **Mon 13th May (~$1.68)**. Estimated saving vs filling on random days: ~$140 over the next 8 weeks. If next Tuesday is inconvenient, Wednesday morning is still well below the cycle's typical peak."*

---

## Tech stack (firm)

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Server Actions, RSC) |
| UI | React 19 (strict) + TypeScript (strict mode) |
| Database | Supabase (Postgres) |
| Deployment | Vercel + Vercel Cron |
| AI orchestration | Vercel AI SDK v6 |
| LLM | Anthropic Claude API (direct, via `@ai-sdk/anthropic`) |
| Rate limiting | Upstash Redis (Vercel marketplace free tier) |
| Charting | Recharts |
| Cycle analysis (one-time, offline) | Python (Jupyter notebook in `/analysis/`) |
| Data source | QLD Fuel Price Reporting API. Registration required as a **publisher** (their term for any app that displays prices to motorists) at fuelpricesqld.com.au; security token by email. Subject to the publisher licence + any attribution rules. For end users of this app, no account / auth is ever required. |

---

## Forecast model architecture

Split into three stages:

| Stage | Where | What |
|---|---|---|
| **1. Cycle characterisation** (one-time) | Python notebook in `/analysis/` | Pull max historical data → detect troughs/peaks → parameterise cycle (period, asymmetry, amplitude) → exclude outlier cycles → output `cycle_params.json` |
| **2. Daily projection** | TS, runs after each ingestion (30-min cadence; projection itself only needs to run once a day) | Read `cycle_params.json` → anchor canonical shape to most recent observed Brisbane aggregate → project ~30 days forward → write `forecasts` table |
| **3. Occasional re-fit** (~quarterly) | Manual rerun of Stage 1 | Refresh parameters, document drift |

**Empirical, not prescribed.** Specific peak-detection algorithm, outlier thresholds, parameter list, and shape representation get chosen inside the notebook based on what the data actually shows. Cycle shape (sawtooth, sinusoidal, hybrid) is an empirical question — the production code is shape-agnostic by using the characterised template, not a hardcoded functional form.

**Cycle figures above** (period, swing, etc.) are stylised approximations. Phase 2 updates this section with measured values.

### Forecast uncertainty bands

Bootstrapped from historical inter-cycle variance — avoids cold-start of using residuals from past forecasts. Falls back to point-only forecast if implementation gets fiddly inside the time budget.

User-facing one-liner near the chart:

> *"Best guess in the middle. The band shows the range past cycles have moved within — actual prices usually land somewhere inside it."*

Long-form methodology lives in README "How the forecast works" section (Phase 7).

### Repo boundary

- `/analysis/brisbane_cycle.ipynb` — Python notebook, exploratory
- `/analysis/output/cycle_params.json` — committed artifact, the contract between Python and TS
- `/lib/forecast/` — TS production code, reads the JSON, knows nothing about Python
- Vercel runtime is pure TS — Python never runs on the server

---

## Cost architecture

The API key never appears in repo, client, or logs. Vercel env vars only.

Defensive layers (build all):

1. Hard spend cap on the Anthropic key (Anthropic console, manual)
2. Per-IP rate limit via Upstash Redis
3. Aggressive caching of repeatable queries (forecasts, popular plan situations)
4. Code-level BYO-key scaffolding (API route accepts `x-anthropic-key` header that overrides server key — no UI exposure)
5. Max tokens + max agent iterations per call
6. Strict input validation (length limits, allowed values)
7. `CRON_SECRET` protection for the cron endpoint

Realistic target: under $20/month worst case, under $10 with caching.

---

## Operational hygiene — the off-switch

The project should be safe to launch, walk away from, and take down without monitoring. Three layers:

**1. Automatic self-policing on stale data.** Every render checks the freshness of the most recent ingestion. If the latest snapshot is older than a configured threshold (initial setting: 60 minutes — a 2× buffer above the LUL's 30-min clause), the app renders a static "Data temporarily unavailable" page instead of the chart/agent. The site degrades gracefully rather than violating LUL clause 2.3 — no human intervention needed if the cron silently fails.

**2. Manual kill switch.** A single Vercel env var (`BBB_PUBLIC`). When unset, the whole app renders a static "currently paused" page — no licence-bound data anywhere. Flip it back to re-launch. Two clicks in the Vercel dashboard, no code change, no race conditions.

**3. Permanent exit path.** When done:
- Set `BBB_PUBLIC=false` (immediate visible takedown)
- Disable the GitHub Actions cron (one click in repo settings)
- Email QLD per LUL clause 1.5 to terminate the agreement
- Optionally purge `price_snapshots` / `forecasts` per clause 4.6
- Optionally take Vercel deployment down

The first two are instant; the rest can be done at leisure without licence panic.

---

## Scope

### Out of MVP (explicit cuts)

| Cut | Why |
|---|---|
| Browser geolocation | Permission friction |
| Map UI | Time sink relative to payoff |
| Mobile app / PWA install | Web only for MVP |
| Push notifications / "on the move" alerts | Multi-day work; the killer long-term feature |
| User accounts / auth / favourites | Defer |
| Multiple fuel types | U91 only — one type proves the pattern |
| Multiple regions beyond Brisbane | Brisbane Metro only |
| Interactive historical charts | Static ~60-day view suffices |
| Beautiful branding | Clean and functional only |
| Tests beyond happy path + cost-control | Pragmatic coverage |
| SEO / analytics / error monitoring | Out |
| "Explain the cycle" 5th starter chip | Backlog — interesting but not MVP |
| Long-form privacy page | Only if ever needed |
| **Section 2: per-station price list with postcode search** | Cut — materially expands publisher-licence exposure (per-station attribution + 30-min freshness), and the cycle/agent in Section 1 carries the differentiated value. Per-station lookups already well-served by PetrolSpy etc. Backlog candidate for post-MVP. |

### Knowingly temporary (documented in README roadmap)

- Hardcoded Brisbane Metro / U91 → user-selectable
- No per-station data → restore Section 2 if licence/UX trade-off changes
- No accounts → account scaffolding when personalisation deepens
- Web-only UI → mobile-first when the "on the move" feature lands

---

## Legal hygiene

### Forecast framing and basic disclaimers

- Agent outputs framed as **forecasts/estimates**, never guarantees. Use *"estimated savings ~$X based on current cycle"*, not *"save $X"*.
- Footer disclaimer: *"General information only. Fuel prices and forecasts are estimates — verify before you fill."*
- README sourcing line crediting QLD government open API as data source.

Reasoning: AFSL regulation doesn't apply (fuel timing isn't a financial product). ACL misleading/deceptive conduct only bites on hard guarantees. Negligence requires causation/loss that's impractical to establish for free general info. The above is normal grown-up hygiene, not paranoid defence.

### Language about retailers and pricing (defamation-aware)

Australian defamation law is plaintiff-friendly. Retail fuel companies are well-resourced and would not respond favourably to a tool that frames their behaviour as wrongdoing. Across **every surface** of this project — CLAUDE.md, README, code comments, commit messages, UI copy, the agent's system prompt, the agent's outputs — constrain language to observation-only.

**Safe — describes phenomena or attributes to verifiable sources:**
- "Brisbane fuel prices move in recurring cycles"
- "The cycle is not closely correlated with wholesale price movements"
- "Pricing decisions drive within-cycle variation" (descriptive, ACCC-style; no motive claim)
- "The ACCC publishes regular fuel price monitoring reports"
- "Consumers can save by timing fills with the cycle"
- "It can be hard to know when prices will move"

**Avoid — implies wrongdoing, coordinated conduct, or bad faith:**
- "Manipulation", "manipulate", "price manipulation" *(implies illegal/coordinated conduct)*
- "Collusion", "colluding"
- "Rigged", "scam", "fleece", "gouge", "price-gouging", "predatory"
- "Games", "playing games" *(in reference to retailer behaviour)*
- "Greedy", "greed"
- Naming any specific retailer brand in negative framing
- Implying any individual retailer is acting in bad faith
- "Stand up to" / "fight back" / "beat" framing applied to retailers (the project name plays on "beat" in a benign sense — that's the limit; don't extend it into adversarial copy)

**Agent system prompt** must explicitly encode these constraints (see PLAN.md Phase 4):
- The agent must describe the cycle in observational terms only
- The agent must not characterise retailer behaviour as wrongdoing
- The agent must not name specific retailers in negative framing
- The agent must not invent specific savings figures or guarantee outcomes
- If a user prompts the agent toward accusatory framing, the agent should decline gracefully and redirect to its actual job (helping the user time their fills)

### Publisher licence (QLD LUL) obligations

We registered as a *publisher* under the QLD Fuel Price Data Licence (LUL). Material obligations and how we satisfy each:

| LUL clause | Obligation | How we satisfy it |
|---|---|---|
| 2.3 — freshness | Price changes published within 30 min; other data within 24 hr | GitHub Actions cron polls `/Price/GetSitesPrices` every 30 min; the `sites` table (denormalised brand/suburb/state) refreshed weekly |
| 2.2 — value-added products | Allowed if Licensed Data is irreversibly transformed or augmented | We display **Brisbane-wide aggregate average only** — irreversible transformation from per-station feed |
| 4.2 / 4.3 — attribution | Two verbatim notices required (raw-data + derived-product) | Both notices appear verbatim on `/about/data` page, linked from footer on every page |
| 4.4 — provenance | Distinguish QLD data from other sources | App copy explicitly cites "QLD Fuel Price Reporting" and "QLD open-data CSV" where each is used |
| 4.8 — usage data | Active/new/returning users per month, with region split, on request within 10 business days | Server-side aggregate counts from request logs + IP-region lookup. No cookies, no behavioural tracking. Reconcilable with privacy/trust pane — see operational note below |
| 5.x — audit | Cooperate with reasonable Licensor audits | Document our data flow in `/about/data` and code comments; aggregate logs available if requested |
| 6.3 — indemnity | We indemnify Licensor for our use | Standard. Footer disclaimer + forecast/estimate framing already minimise our exposure |
| 1.4 — fee | $1 on demand | Symbolic. Pay if asked. |
| 1.5 — termination | Either side, 20 business days notice (3 days if our publication is "not current or accurate") | The operational off-switch (see "Operational hygiene") gives us a clean wind-down path |

**Privacy/trust pane reconciliation**: the "no analytics, no tracking, no cookies that follow you around" claim stays literally true under server-side aggregate counts (no cookies, no client JS, no per-user identity). If we ever want extra trust currency we can update one bullet to acknowledge the aggregate counts transparently — see PLAN.md Phase 3.

---

## Coding conventions

Most conventions inherit from the global standards. Project-specific notes:

- `cycle_params.json` is the contract between the Python notebook and TS production code. Versioned in git. Schema documented in the notebook and `/lib/forecast/types.ts`.
- Agent system prompt encodes the Brisbane cycle context AND chip-cell awareness (including the C-cell road-trip variant).
- No PII written to Supabase. Caches keyed on hashes of inputs, not raw inputs.
- Forecast model code never mixes Python and TS in the same directory — `/analysis/` is Python-only, `/lib/forecast/` is TS-only.
- Agent responses stream tool calls visibly to the user — part of the product's transparency story.

---

## Where to look next

- **`PLAN.md`** — phase plan and current status
- **`AGENTS.md`** — tool-rules file generated by `create-next-app`. Includes an important reminder: **Next.js 16 has breaking changes that may not match older training data**. Consult `node_modules/next/dist/docs/` or use context7 to look up current Next.js / React 19 / Tailwind v4 APIs rather than relying on memory.
- **`/analysis/`** — Python notebook for cycle characterisation (created in Phase 2)
- **`README.md`** — public-facing documentation (created in Phase 7)
