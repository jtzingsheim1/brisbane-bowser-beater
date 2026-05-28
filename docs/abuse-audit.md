# Abuse & cost-blowup audit (Phase 6)

The project is designed to be **safe to launch and walk away from**. The one
real financial exposure is the Anthropic API (the fuel-strategist agent); every
other surface is read-only aggregate data. This document enumerates each
cost-blowup / abuse vector and the defence(s) in place, with residual risk
noted. Re-check before deploy and whenever the agent surface changes.

> **Ultimate backstop:** a hard monthly spend cap set manually on the Anthropic
> key (Anthropic console). No matter what gets past the layers below, spend
> cannot exceed that cap — the agent simply stops responding. Set this at
> Phase 8 before going public.

## Defence layers (summary)

| # | Layer | Where |
|---|---|---|
| 1 | Hard Anthropic spend cap (manual) | Anthropic console |
| 2 | Per-IP rate limit (10 / 60 s) | `src/lib/rate-limit.ts` (Upstash) |
| 3 | Aggressive caching of repeatable work | `unstable_cache` on aggregates/forecast/narrative; forecast precomputed by cron |
| 4 | BYO-key override | `x-anthropic-key` header in the agent route |
| 5 | Max output tokens (1500) + max agent steps (6) | `src/app/api/agent/route.ts` |
| 6 | Strict input validation (msg count, total chars, JSON guard) | agent route |
| 7 | `CRON_SECRET` on the forecast route | `src/app/api/cron/forecast/route.ts` |
| 8 | Kill switch + staleness gate | `BBB_PUBLIC`, `src/lib/freshness.ts` |

## Vectors

### 1. Rate-limit bypass via rotating IPs / VPN / proxy
- **Risk:** an attacker cycles IPs to evade the per-IP limit and drive agent calls.
- **Defences:** per-IP sliding window (layer 2) raises the cost of casual abuse; **max output tokens + max steps (layer 5)** cap the spend of *each individual* call regardless of who makes it; the **hard spend cap (layer 1)** bounds the absolute monthly worst case. Aggressive caching (layer 3) means repeated identical situations are cheap.
- **Residual:** a determined, IP-rotating attacker can still burn calls up to the spend cap. Accepted — the spend cap is the deliberate ceiling. Plan caching by `(situation_hash, day)` (Phase 4 backlog) would further blunt this.

### 2. Cache bypass via random query parameters
- **Risk:** appending random query strings to defeat caches and force recompute.
- **Defences:** server-side caches (`unstable_cache`) key on **explicit cache keys / function args**, not the raw request URL, so junk query params don't change the key. The forecast and aggregates are precomputed/cached server-side; the chart never triggers per-request LLM work. The agent is POST-only with a validated JSON body — query params are ignored.
- **Residual:** negligible.

### 3. Prompt injection driving runaway token output
- **Risk:** a crafted prompt coerces the agent into very long output or many tool calls.
- **Defences:** **`maxOutputTokens: 1500`** hard-caps any single response; **`stepCountIs(6)`** caps tool-call iterations; input is length-validated before the model is invoked (layer 6). The system prompt constrains scope. Output length is bounded *by the SDK*, not by the model's cooperation.
- **Residual:** injection could still produce off-topic or accusatory text — mitigated by the system prompt's language constraints, not by cost (cost is already bounded).

### 4. Infinite agent loops (tool call → tool call → …)
- **Risk:** the agent loops calling tools without terminating.
- **Defences:** **`stepCountIs(6)`** is a hard stop on iterations; both tools are read-only and fast (cached Supabase reads); `maxDuration = 30` bounds wall-clock.
- **Residual:** none material — 6 steps × bounded tokens is a small, fixed ceiling per request.

### 5. Direct API endpoint hits bypassing the UI
- **Risk:** scripts POST straight to `/api/agent`, skipping any client-side guardrails.
- **Defences:** all real protection is **server-side** (layers 2, 5, 6) — there are no client-only guards to bypass. The 503-when-unconfigured and input validation apply to every caller equally.
- **Residual:** same as vector 1 (bounded by rate limit + spend cap).

### 6. Cron endpoint abuse
- **Risk:** repeated hits to `/api/cron/forecast` to force recompute / writes.
- **Defences:** **`CRON_SECRET`** (Bearer) gates the route when set (layer 7). The route is idempotent-ish (writes a new versioned batch) and does no LLM work, so even an authorised flood is cheap DB writes, not Anthropic spend. The live ingest/forecast **GitHub Actions** jobs don't traverse this route at all (they write straight to Supabase), so the public route is non-critical.
- **Residual:** set `CRON_SECRET` in production. Without it the route is open but harmless (no LLM, bounded DB writes).

### 7. Log leakage of the API key
- **Risk:** the Anthropic / Supabase keys end up in logs or responses.
- **Defences:** keys are read from env only and **never logged or returned**. The BYO `x-anthropic-key` header is used to construct the provider and never echoed. Error messages return generic text, not stack traces or env values. `.env.local` is gitignored; a `Read(.env.local)` deny rule guards against accidental reads in the dev agent.
- **Residual:** standard "trust the platform" (Vercel/GitHub secret stores). No app-level leak path identified.

### 8. Long-input attacks (context stuffing)
- **Risk:** a huge message body inflates token usage / cost.
- **Defences:** **20-message cap, 16k-char total cap, JSON parse guard** (layer 6) reject oversized input *before* the model is called. `maxOutputTokens` bounds the response side.
- **Residual:** negligible — input is bounded before any spend.

### 9. Multi-tab / scripted hammering of the agent
- **Risk:** one visitor opens many tabs or scripts rapid-fire requests.
- **Defences:** per-IP rate limit (layer 2) treats all of one visitor's tabs as one IP; per-call caps (layer 5) bound each; spend cap (layer 1) bounds the total.
- **Residual:** bounded by the same ceilings as vector 1.

### 10. Data-licence exposure (non-cost, but launch-critical)
- **Risk:** serving stale licensed data (LUL 2.3) or per-station prices.
- **Defences:** **staleness gate** renders a maintenance page if the latest ingestion is older than the configured threshold (default 60 min — 2× the 30-min LUL clause; env-tunable via `BBB_STALENESS_MINUTES`, clamped to 24 h max); **aggregate-only** display (no per-station prices anywhere on the public surface); `BBB_PUBLIC` kill switch for instant takedown.
- **Residual:** see CLAUDE.md "Operational hygiene" — the off-switch path is deliberate.

## Pre-deploy checklist (verify at Phase 8)
- [ ] Anthropic hard spend cap set in the console.
- [ ] `KV_REST_API_*` (Vercel Upstash Marketplace integration) or `UPSTASH_REDIS_REST_*` provisioned → rate limiter active (confirm a 429 after the threshold).
- [ ] `CRON_SECRET` set; unauthenticated `/api/cron/forecast` returns 401.
- [ ] `USAGE_SALT` set; no raw IPs anywhere in the DB.
- [ ] `ANTHROPIC_API_KEY` only in Vercel env — not in repo, client bundle, or logs.
- [ ] `BBB_PUBLIC=false` flips the whole site to the paused page.
- [ ] Simulate a stale snapshot → maintenance page renders.
