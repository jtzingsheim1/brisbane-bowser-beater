# Phase 8 — Deploy runbook

Everything in the codebase is deploy-ready; this is the mechanical checklist for
the human steps (Vercel + external dashboards). Work top to bottom. Nothing here
needs a code change.

## 0. Already done (no action)
- GitHub Actions secrets set (`QLD_FUEL_API_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`) — the ingest / sites / forecast jobs run on schedule.
- Supabase migrations auto-apply on merge to `main`.

## 1. Provision external services
- **Anthropic spend cap** — console → Billing → set a hard monthly cap. *This is
  the ultimate cost backstop; do not skip.*
- **Upstash Redis** — add via the Vercel Marketplace (free tier). It injects
  five env vars; the limiter uses `KV_REST_API_URL` / `KV_REST_API_TOKEN` (the
  REST pair, not the redis:// `KV_URL`/`REDIS_URL`, and not the read-only
  token). The limiter also accepts the native `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN` names as a fallback, so manual provisioning works
  too. **Gate: provision before any public sharing** — without it the per-IP
  rate limit is OFF and the Anthropic spend cap is the only backstop against
  agent abuse.
- **Generate secrets** — `openssl rand -hex 32` twice, for `CRON_SECRET` and
  `USAGE_SALT`.

## 2. Vercel project
- Import the GitHub repo. Framework auto-detects as Next.js; no `vercel.json` needed.
- Set environment variables (Production):

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | from Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | secret — server only |
| `ANTHROPIC_API_KEY` | ✅ | the agent; 503s without it |
| `USAGE_SALT` | ✅ | enables LUL 4.8 counting; no-op without |
| `CRON_SECRET` | ✅ | **set it** — without it `/api/cron/forecast` is open to anyone (the GH Actions jobs write straight to Supabase and don't use this route, but the public endpoint still exists) |
| `KV_REST_API_URL` | ◻ | auto-injected by the Vercel Upstash Marketplace integration; the limiter reads this (or `UPSTASH_REDIS_REST_URL` as fallback) |
| `KV_REST_API_TOKEN` | ◻ | auto-injected; the read-write token. The limiter writes counters, so the read-only token won't work |
| `BBB_PUBLIC` | ✅ | **leave `false` for now** — see step 4 |
| `BBB_STALENESS_MINUTES` | ◻ | optional override for the staleness gate (default 60). Raise it (e.g. `360`) to ride out GitHub Actions cron lag — the chart shows a *daily* aggregate, so hours of intraday lag don't change what's displayed. Set very high to effectively disable the gate. |

- Deploy.

## 3. Verify (before going public — keep `BBB_PUBLIC=false`)
With `BBB_PUBLIC=false`, confirm the site shows the **paused** page (kill switch works).
Then temporarily set `BBB_PUBLIC=true` and check:
- [ ] Homepage renders the chart (history + forecast line + band) and the daily narrative.
- [ ] `/about/data` shows the QLD attribution notices; footer disclaimer present.
- [ ] Agent: pick a chip → streams a dated plan with visible tool calls.
- [ ] Agent guardrail: an accusatory prompt is declined gracefully and redirected.
- [ ] Rate limit (if Upstash set): >10 agent calls in 60s from one IP → HTTP 429.
- [ ] `GET /api/cron/forecast` without the Bearer (if `CRON_SECRET` set) → 401.
- [ ] Staleness: data is fresh (the 30-min ingest is running) → no maintenance page.
- [ ] No secrets in build logs or responses; `usage_monthly_visitors` has rows but **no raw IPs**.

Cross-check against [`abuse-audit.md`](abuse-audit.md) → "Pre-deploy checklist".

## 4. Go live
- Set `BBB_PUBLIC=true` (takes effect on the next request — no redeploy).
- Confirm the live URL serves the real page.

## 5. The off-switch (for later)
To pause or take down — no code change needed:
- **Pause:** `BBB_PUBLIC=false` (instant).
- **Stop the feed:** disable the GitHub Actions workflows.
- **Wind down the licence:** see CLAUDE.md → "Operational hygiene → Permanent exit path".
