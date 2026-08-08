# BBB MCP server

A small, public, read-only [MCP](https://modelcontextprotocol.io) server
exposing Brisbane Bowser Beater's public fuel-price forecast data, so any
MCP-capable AI client can reason over the Brisbane cycle the same way the
site's own strategist does.

Runs as an AWS Lambda behind an auth-gated API Gateway endpoint, deployed
exclusively via GitHub Actions with OIDC. One-time account setup lives in
[`infra/BOOTSTRAP.md`](../infra/BOOTSTRAP.md); all infrastructure is a
single Terraform stack in [`infra/`](../infra/).

## Tools

| Tool | What it returns |
|---|---|
| `get_forecast` | The latest ~30-day Brisbane-area average U91 forecast batch: one predicted price per day plus an uncertainty band where available. Regenerated daily. |
| `get_recent_history` | Observed Brisbane-area daily average U91 prices for the past N days (7 to 120, default 60), with per-day contributing station counts. |
| `get_cycle_model` | The committed cycle characterisation fitted from ~3 years of QLD open data: typical period, trough-to-peak swing, asymmetry, uncertainty, drift notes. Optionally the 100-point canonical cycle shape the forecast projects forward. |

All prices are Brisbane-area daily average U91 in AUD per litre. There is no
per-station data, matching the site itself. Forecasts are estimates, never
guarantees; every response carries the QLD data attribution.

## Connecting

The endpoint uses the MCP streamable HTTP transport (stateless) and requires
an API key in the `x-api-key` header.

Claude Code:

```bash
claude mcp add --transport http bbb <endpoint-url> \
  --header "x-api-key: <key>"
```

Any other MCP client: point it at the endpoint URL with the same header.
Simple requests work with plain curl too:

```bash
curl -s <endpoint-url> \
  -H "x-api-key: <key>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Architecture

```
MCP client
  | POST /mcp  (x-api-key)
  v
API Gateway (REST)  ..... auth gate + throttle + monthly quota
  | AWS_PROXY
  v
Lambda bbb-mcp-server  .. stateless MCP over streamable HTTP (JSON mode)
  |                       get_cycle_model: bundled JSON, zero I/O
  v
Supabase PostgREST  ..... anon-key reads of the same public aggregates
                          the website serves
```

- **Server** (`mcp/src/`): TypeScript on Node 22, the official
  `@modelcontextprotocol/sdk` web-standard transport, bundled to a single
  file with esbuild. No framework, no Supabase client library; the data
  layer is two plain-fetch request shapes against one host.
- **Infrastructure** (`infra/`): one Terraform root module. Lambda, REST
  API, API key, usage plan, log group, execution role. `terraform destroy`
  removes the entire footprint in one command.
- **Deploys** (`.github/workflows/mcp-deploy.yml`): manual workflow with
  plan / apply / destroy modes, gated behind the `aws` GitHub environment
  which requires human approval. CI (`ci.yml`) typechecks, tests, builds,
  and `terraform validate`s the subproject on every push with no
  credentials at all.

## Security posture

**Authentication and abuse limits.** The endpoint requires an API key
(`x-api-key`), enforced by API Gateway before any code runs. The same
gateway usage plan throttles to 5 requests/second (burst 10) and caps usage
at 100k requests per calendar month, so worst-case cost and abuse are
bounded at the front door. The key value exists only inside AWS: it is not
a Terraform output, never appears in workflow logs, and is retrieved by the
operator directly in CloudShell. Rotation is a two-minute self-serve
action.

**No long-lived credentials, anywhere.** The AWS account has no IAM users
and no access keys. Deploys assume a role via GitHub's OIDC provider, and
the role's trust policy only matches workflow runs of this repository's
`aws` environment, which requires a named human reviewer. Short-lived
credentials therefore only ever exist inside a deploy run a human has
approved.

**Least privilege, both directions.**

- The *deploy role* can manage only resources named `bbb-mcp-*` (IAM,
  Lambda, logs) plus this region's API Gateway surface and the single
  Terraform state prefix. It cannot read data, create users, or touch
  anything outside the stack.
- The *runtime role* (what the server itself runs as) can write its own
  CloudWatch log group. That is the complete list; the running server can
  reach no other AWS API by construction.

**What the server can and cannot do.**

- Can: serve three read-only tools over data that is already public (the
  site's aggregate forecast, history, and cycle model), reading Supabase
  with the same publishable anon key the website ships to every browser.
- Cannot: write to anything, reach per-station data (the anon role's
  grants don't expose it), trigger paid API calls (no Anthropic, no QLD
  API; only stored aggregates), or mint further access of any kind.
- Upstream errors are collapsed to a generic message; internal details and
  upstream status codes are not surfaced to callers.

**Blast radius.** Full compromise of the API key lets someone read public
data slightly faster than anonymous visitors can, within the same throttle
and quota. Full compromise of the AWS account destroys the MCP server and
nothing else: BBB's website, database, and data pipelines share none of
this account's infrastructure.

**Decommission.** Run the deploy workflow in `destroy` mode (still gated by
the same human approval). The one-time bootstrap resources outside the
stack (OIDC provider, deploy role, state bucket, budget) are removed with
the reverse of the bootstrap script, documented in
[`infra/BOOTSTRAP.md`](../infra/BOOTSTRAP.md).

## Development

```bash
cd mcp
npm ci
npm run check     # typecheck + tests + esbuild bundle
```

Tests drive the real Lambda handler with synthetic API Gateway events and a
mocked Supabase, covering the full JSON-RPC path. A language-discipline
test enforces the project's observation-only wording rules (see the
repository's CLAUDE.md, "Legal hygiene") on every string this server
ships.

Infrastructure checks:

```bash
cd infra
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
```

## Data and attribution

Data: QLD Fuel Price Reporting, [data.qld.gov.au](https://www.data.qld.gov.au)
(CC BY 4.0), aggregated and transformed by Brisbane Bowser Beater; see
[the site's data page](https://brisbane-bowser-beater.vercel.app/about/data)
for the full notices. General information only. Fuel prices and forecasts
are estimates; verify before you fill.
