# Brisbane Bowser Beater

A single-page web app for Brisbane drivers, combining live fuel price data with an AI-powered fuel strategist agent. Helps consumers time and locate their fills around Brisbane's pronounced artificial retail fuel price cycle.

---

## Brisbane fuel cycle (essential context)

Australian retail fuel prices in major capital cities exhibit recurring cycles that have been studied by the ACCC, which publishes regular [fuel and petrol monitoring reports](https://www.accc.gov.au/by-industry/petrol-and-fuel/fuel-and-petrol-monitoring). The cycles are not closely correlated with wholesale price movements. The specific characteristics of the **current** Brisbane cycle — period, amplitude, asymmetry, shape, regularity, typical station spread — are what this project's Phase 2 characterisation measures from QLD Fuel Price Reporting API data.

**Measured characterisation (Phase 2, landed 2026-05).** The offline Python pipeline in `/analysis/` characterised the cycle from ~35 months of QLD open-data CSVs (2023-03 → 2026-02, Brisbane core-Metro U91, 20 cycles after excluding 64d+ merges). Observation-only figures, now the source of truth in `analysis/output/cycle_params.json`:

- **Cycle length** ~39 days (recency-weighted; inter-cycle range ~31–46).
- **Swing** ~$0.35/L trough-to-peak, stable across all three years.
- **Shape** asymmetric — the climb to the peak occupies ~38% of the cycle, the easing-back ~62% (prices rise faster than they come down).
- **Observed drift 2023→2025**: cycle length has been shortening (~3 d/yr), the easing-back phase has steepened (statistically significant), swing size unchanged. Recorded in `cycle_params.json` `drift_notes`; re-fit quarterly.

These numbers are measured facts about the *price series*, framed as observations of the cycle — not characterisations of retailer conduct (see Legal hygiene). They've since been adopted into user-facing UI + agent narratives (Phase 2 chunk 5, PR #23), under the same language discipline.

**Equally important — language discipline (defamation-aware).** See "Legal hygiene → Language about retailers and pricing" below. The cycle is an observation; the project does not characterise retailer behaviour as wrongdoing, and language across all surfaces must respect that. Australian defamation law is plaintiff-friendly and well-resourced retail fuel companies would not respond favourably to a tool that frames their behaviour as wrongdoing.

Ongoing:
- Public-facing UI and the agent describe the cycle in **observation-only terms** (e.g., *"Brisbane prices move in recurring cycles; we forecast where they're going"*) — no causal characterisation of retailer behaviour.
- The measured figures above are cited as estimates/observations, never as guarantees or as claims about why retailers price as they do.
- The chart itself implicitly shows the magnitudes — let the data speak.

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
| **Frequent (≈ weekly or more)** | A: Routine commuter, same fills every week | B: Frequent filler with options to shift |
| **Infrequent (≈ fortnightly or less)** | C: Light driver, tight constraints when fuel is needed | D: Light driver with lots of slack |

**Frequency split is anchored at ~fortnightly**, the estimated median Brisbane fill interval (back-of-envelope: ~12,000 km/yr ÷ ~425 km effective range per fill ≈ 28 fills/yr ≈ every ~13 days). Splitting there — rather than at "weekly" — keeps the four cells as four roughly equal groups, and gives users a concrete anchor ("weekly or more" vs "every 2+ weeks") instead of the ambiguous "often". The flexibility axis can't be measured, so it's split by a relatable behavioural test ("could you move your next fill by 2–3 days?"). UI chip labels and the agent system prompt both reflect this anchoring; re-confirm if the median estimate is ever revised with real data.

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
- Only the planner is AI. The forecast chart is deterministic.
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
| Deployment | Vercel (hosting) + GitHub Actions (cron — free for public repos, keeps Vercel Hobby clean) |
| AI orchestration | Vercel AI SDK v6 |
| LLM | Anthropic Claude API (direct, via `@ai-sdk/anthropic`) |
| Rate limiting | Upstash Redis (Vercel marketplace free tier) |
| Charting | Recharts |
| Cycle analysis (one-time, offline) | Python scripts in `/analysis/` (own venv; no notebook) |
| Data source | QLD Fuel Price Reporting API. Registration required as a **publisher** (their term for any app that displays prices to motorists) at fuelpricesqld.com.au; security token by email. Subject to the publisher licence + any attribution rules. For end users of this app, no account / auth is ever required. |

---

## Forecast model architecture

Split into three stages:

| Stage | Where | What |
|---|---|---|
| **1. Cycle characterisation** (one-time) | Python scripts in `/analysis/` | Pull max historical data → detect troughs/peaks → parameterise cycle (period, asymmetry, amplitude) → exclude outlier cycles → output `cycle_params.json` ✅ landed 2026-05 |
| **2. Daily projection** | TS, runs after each ingestion (30-min cadence; projection itself only needs to run once a day) | Read `cycle_params.json` → anchor canonical shape to most recent observed Brisbane aggregate → project ~30 days forward → write `forecasts` table |
| **3. Occasional re-fit** (~quarterly) | Manual rerun of Stage 1 (`analysis/refresh_all.py` — one command regenerating `cycle_params.json` **and** the committed visuals/data artifacts together) | Refresh parameters, document drift, re-author `anomaly_notes` by hand (script prints a reminder) |

**Empirical, not prescribed.** Specific peak-detection algorithm, outlier thresholds, parameter list, and shape representation get chosen inside the analysis scripts based on what the data actually shows. Cycle shape (sawtooth, sinusoidal, hybrid) is an empirical question — the production code is shape-agnostic by using the characterised template, not a hardcoded functional form.

### Forecast uncertainty bands

Bootstrapped from historical inter-cycle variance — avoids cold-start of using residuals from past forecasts. Falls back to point-only forecast if implementation gets fiddly inside the time budget.

User-facing one-liner near the chart:

> *"Best guess in the middle. The band shows the range past cycles have moved within — actual prices usually land somewhere inside it."*

Long-form methodology lives in README "How the forecast works" section (Phase 7).

### Repo boundary

- `/analysis/*.py` — Python scripts (own venv), exploratory but version-control-friendly: `download_data.py` (cache QLD CSVs), `cycle_lib.py` (load + daily series), `cycle_fit.py` (detrend/detect/canonical), `trend_check.py` (drift test), `build_params.py` (finalise). No notebook — deliberate (clean git diffs).
- `/analysis/output/cycle_params.json` — committed artifact, the contract between Python and TS
- `/analysis/output/history_daily.json` + `cycle_shapes.json` — committed artifacts behind the public cycle visuals (education charts, README images, OG card), emitted by `analysis/figures.py` pinned to the committed fit; `src/lib/history/artifacts.test.ts` fails the build if they drift from `cycle_params.json`
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

**1. Automatic self-policing on stale data.** Every render checks the freshness of the most recent ingestion. If the latest snapshot is older than a configured threshold (default 60 minutes — a 2× buffer above the LUL's 30-min clause), the app renders a static "Data temporarily unavailable" page instead of the chart/agent. The threshold is env-tunable via `BBB_STALENESS_MINUTES` (positive integer, clamped to 24 h max) — right-sized for the actual product, which is a daily aggregate average where a few hours of intraday lag doesn't change what's displayed. Set to a higher value (e.g. 360–720) to ride out GitHub Actions scheduler lag; leave unset for the conservative default. The site degrades gracefully rather than violating LUL clause 2.3 — no human intervention needed if the cron silently fails.

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

- `cycle_params.json` is the contract between the Python analysis scripts and TS production code. Versioned in git. Schema documented inline in `analysis/build_params.py` and mirrored in `src/lib/forecast/types.ts`. The manually-authored `anomaly_notes` block (added for the Feb–Apr 2026 anomaly, issue #47 PR-3) is written by hand into the JSON; re-author on every quarterly re-fit since the Python pipeline doesn't generate it.
- Agent system prompt encodes the Brisbane cycle context AND chip-cell awareness (including the C-cell road-trip variant).
- No PII written to Supabase. Caches keyed on hashes of inputs, not raw inputs.
- Forecast model code never mixes Python and TS in the same directory — `/analysis/` is Python-only, `/lib/forecast/` is TS-only.
- Agent responses stream tool calls visibly to the user — part of the product's transparency story.
- **Supabase tables need explicit GRANTs.** The project's "Automatically expose new tables" setting is OFF (deliberate — explicit control over the Data API surface). Every new table needs `grant select on <table> to anon` and `grant all on <table> to service_role` in its migration. Migration 0004 sets `alter default privileges` for future tables, but verify each migration grants explicitly as belt-and-braces — default privileges only cover tables created by the same role that ran the ALTER, which may not be the role running future migrations.

---

## MCP server subproject (`mcp/` + `infra/`)

A cleanly bounded subproject serving BBB's public forecast data to AI clients
over MCP (streamable HTTP). Framed everywhere as a natural extension of BBB.

- `mcp/` -- TypeScript Lambda, own `package.json`/lockfile, five read-only
  tools: three over public forecast data (`get_forecast`,
  `get_recent_history`, `get_cycle_model`; plain-fetch Supabase anon reads,
  `cycle_params.json` bundled at build time) and two docs Q&A tools
  (`search_docs`, `ask_docs`) grounded in a curated corpus of this repo's
  public docs (`mcp/corpus-manifest.txt`) via a Bedrock knowledge base.
  The only paid call anywhere is `ask_docs` generation (Claude Haiku 4.5
  via Bedrock), bounded by layered AWS-enforced cost guards (500/month
  gateway quota per key, per-request caps, a USD 5 budget action that denies
  Bedrock at 100%) -- see `docs/mcp-rag-design.md`.
- `infra/` -- single Terraform root module (Lambda + REST API Gateway with
  API key + usage plan; Bedrock knowledge base + S3 Vectors index + corpus
  bucket + budget action for the RAG stack). `terraform destroy` = full
  decommission.
- Deploys ONLY via `.github/workflows/mcp-deploy.yml` (GitHub OIDC into the
  `aws` environment, human-approval gated). No long-lived AWS credentials
  exist anywhere -- sessions must never hold AWS keys. One-time account setup:
  `infra/BOOTSTRAP.md`.
- Security posture documented in `mcp/README.md`. The language discipline
  (Legal hygiene above) applies to every string the server ships and is
  enforced by a test.
- The deploy role's policy grants wildcard actions, mostly on
  name-prefix-scoped resources (`lambda:*`, `s3:*` on the corpus bucket,
  `s3vectors:*`, `budgets:*`). `apigateway:*` is the exception: API Gateway
  ARNs carry ids rather than names, so it cannot be prefix-scoped and is
  scoped to the region instead. All of it is acceptable here only because
  every session of that role requires a human-approved workflow run from
  main, and because the account holds nothing else. Do not carry the
  pattern into anything whose deploys are not approval-gated.
- The two permissions boundaries that cap every role the stack creates live
  in `infra/BOOTSTRAP.md` (written by a human in CloudShell, deliberately
  not by Terraform, so the deploy cannot widen its own ceiling).
  `tests/infra-boundaries.test.ts` holds those documents and the inline
  role policies in `infra/*.tf` to exact action parity in both directions,
  pins each role's grants individually, and checks the deploy policy's
  boundary pinning. Actions only: resource scoping is not compared. Other
  grant routes (`aws_iam_role_policy_attachment`) are asserted not to
  exist rather than modelled, so do not introduce one without extending
  the guard. Applied to the live account 2026-08-23.
- House style for this subproject's public docs: no em dashes (use " -- " or
  restructure).

## Where to look next

- **`PLAN.md`** — phase plan and current status
- **`AGENTS.md`** — tool-rules file generated by `create-next-app`. Includes an important reminder: **Next.js 16 has breaking changes that may not match older training data**. Consult `node_modules/next/dist/docs/` or use context7 to look up current Next.js / React 19 / Tailwind v4 APIs rather than relying on memory.
- **`/analysis/`** — Python scripts for cycle characterisation (Phase 2; outputs `output/cycle_params.json`). See `analysis/requirements.txt`; run in its own venv.
- **`README.md`** — public-facing documentation (created in Phase 7)
