# MCP auto-deploy: design and build plan

DRAFT v4, 2026-11-11. Three review rounds, each with fresh independent
reviewers. v1 (one narrowed deploy role) failed round 1. v2 (two roles)
held its shape in round 2, but the reviewers broke its worst-case bound
and several build details. v3 narrowed the unattended role to "replace
the Lambda's code"; round 3 judged it buildable with policy-text fixes,
which v4 applies. Before merge this document is rewritten as post-merge
truth (see the last section).

## 1. Problem

Every change to the MCP stack (`mcp/`, `infra/`) reaches AWS only through
`.github/workflows/mcp-deploy.yml`, in two manual steps: the maintainer
dispatches the workflow, then approves the pending run on the `aws` GitHub
environment, which has a required reviewer.

The project is in caretaker mode. The routine work is the weekly
Dependabot batch, run by a Claude session the maintainer starts and skims.
From `git log` (2026-08-01 to 2026-11-11): 44 of 72 commits on main touched
`mcp/` or `infra/`, 33 of them Dependabot, and every weekly batch since
late August included at least one MCP or Terraform bump. So the stack
changes every week, and each change waits for two manual steps.

Deploys also lag main. Merged MCP changes sit undeployed until someone
runs the workflow. `analysis/output/cycle_params.json` is bundled into the
Lambda at build time (`mcp/src/cycle-model.ts`), so a quarterly re-fit
leaves `get_cycle_model` serving the old fit until a manual deploy.

## 2. History and what changed

- PR #108 (2026-08-24) made docs-corpus publishing ungated, under a role
  (`bbb-mcp-corpus-sync`) that can only write the corpus bucket and start
  ingestion. `infra/BOOTSTRAP.md` section 3c records the reasoning: the
  merge was already the editorial decision, and an ungated run is
  acceptable when its role can do little.
- The same PR considered ungated code and infra deploys and dropped the
  idea: "the doc toil that motivated it is gone and the gate costs
  nothing" (PLAN.md).
- Since then the project moved to caretaker mode. The gate now costs two
  manual steps every week, and stale deploys are a real failure mode.
  This design reverses the 2026-08-24 decision for one narrow kind of
  deploy, on the section 3c reasoning.

## 3. Goals and non-goals

Goals:

- The routine weekly change (new Lambda code from a dependency bump, a
  re-fit or a code PR) deploys on merge with no step from the maintainer.
- Anything else stops at one approval and says what it is waiting for.
- The weekly report confirms the AWS deploy, as it already confirms the
  Vercel deploy, and never reports a stale deploy as current.
- The worst case of an unattended deploy is bounded by AWS-enforced
  controls, and stated honestly.

Non-goals:

- No autonomous loop: the maintainer starts every session.
- No change to the website's deploy (Vercel on push to main).

## 4. Threat model

AWS trusts a GitHub OIDC subject: the repo plus a GitHub environment,
and the `aws` environment is limited to `main`. So whoever can put code on
main controls what a push-triggered deploy runs:

- the maintainer;
- Claude sessions, through the GitHub tools they use, which can merge PRs
  and (probed 2026-11-11) dispatch workflows. Anthropic's documented
  permission list for the app says Actions read only, but a dispatch of
  a workflow to a nonexistent ref passed authorisation and failed only on
  the ref. So a session can start any workflow on main. For this design
  that equals a push (it deploys main), and destroy, IAM and
  configuration changes still need the maintainer's approval;
- a leaked write token, or an admin token, which can push to main;
- dependency code: npm packages decide what the bundle contains, and
  Terraform providers and pinned actions run in jobs that can mint a
  token (provider integrity rests on the lockfile hashes);
- prompt injection of the Dependabot session, which reads untrusted text
  while it can merge. The skill's rule that it only merges PRs whose every
  commit is Dependabot's is the control.

Consequences for the design:

1. Workflow code and tests on main are attacker-controlled in this model.
   Plan checks, summary matching and smoke tests are accident guards,
   never security controls. Only IAM, role trust and AWS quotas count.
2. A role that can create roles, pass them to Lambda or write trust
   policies can step around any cost backstop. So the unattended path
   gets its own role that can't do any of that.
3. Hostile Lambda code can read its execution role's credentials and use
   them from anywhere. Any code deploy, gated or not, can do this, and it
   is true of today's blind approvals too. So the real cost bound is what
   the server role may call (5.2), at the rate AWS allows (5.2), until the
   backstop fires.

## 5. Design

### 5.1 Two roles

| | `bbb-mcp-update` (new) | `bbb-mcp-deploy` (existing) |
| :- | :- | :- |
| Trusted by | `environment:aws` (no reviewer, main only) | `environment:aws-gated` (new: required reviewer, admin bypass off, main only) |
| Runs | Code-only deploys, unattended | Everything else, after one approval |
| Writes | `lambda:UpdateFunctionCode` on exactly `function:bbb-mcp-server`; tag and untag on the Lambda, corpus bucket, vector store and knowledge base (never IAM or API Gateway tags); corpus object put/delete; start ingestion; Terraform state | Today's statements, minus everything budget-related |
| Reads | `Get*`, `List*`, `Describe*` on stack resources (`logs:DescribeLogGroups` on `log-group:*`, which it requires; `s3:ListBucket` on the corpus bucket), `apigateway:GET`, IAM reads on the stack roles, budget and action reads on `bbb-backstop-*` | Today's, plus budget and action reads on `bbb-backstop-*` |
| Policy | Inline, on a role outside every deploy-policy pattern | Inline, today's |

Why reads are wildcards and writes are not: Terraform's refresh calls many
read APIs per resource, and provider bumps add new ones. Wildcard reads
keep provider bumps from failing the unattended path, and reads change
nothing. One read matters: API Gateway reads return the API keys, so the
update role can read them. A leaked key spends that key's monthly quota,
which the update role can't change. `mcp/README.md`'s "who can read the
key" sentence changes accordingly.

Why only `UpdateFunctionCode`: configuration (environment variables,
timeout, memory, role, layers) needs `UpdateFunctionConfiguration`, and
`PassRole` once the role is involved. Leaving both out means attacker code
keeps the 25-second timeout, 256 MB and the server role that the gated
path set. It also means no `PassRole` on the update role at all. And it
needs no `InvokeFunction`, so the update role can't call `ask_docs`
around the API key.

What lands where:

- **Unattended:** every Dependabot `mcp/` bump, every `cycle_params.json`
  re-fit, code PRs such as #164 and #180, and provider bumps that change
  nothing or only tags.
- **Gated:**
  - IAM changes (#99, #100, #103);
  - API Gateway changes (#104's key description, a second key);
  - new or deleted resources (the RAG stack);
  - Lambda configuration changes (a new environment variable such as
    `BBB_STALENESS_MINUTES`);
  - replacements;
  - destroy.

  Each of those happened at most a few times since August, mostly during
  build-out.

### 5.2 Cost backstop and model scope

- **Human-owned backstop.** The budget, its action, the deny policy and
  the action's role move out of Terraform into a new `infra/BOOTSTRAP.md`
  section 3d. They are named `bbb-backstop-*`, outside every
  deploy-policy pattern. Both deploy roles get explicit Denies on every
  write to them, plus a Deny on `iam:DetachRolePolicy` conditioned on
  `iam:PolicyARN` matching `bbb-backstop-*` (a detach names the role, not
  the policy, so a resource-keyed Deny alone would not stop it). Reads
  stay allowed, for the smoke test. A test asserts no deploy statement's
  resource matches the backstop names.
- **Every role that can spend is covered.** The deny policy covers
  `bedrock:*`, `logs:PutLogEvents` and `s3:PutObject`. The action attaches
  it to the server role, the kb role, the update role and the corpus-sync
  role. Today it covers only Bedrock on the server role.
  `bbb-mcp-boundary-iam` stays the backstop role's boundary and widens to
  those roles. The parity test learns to model a role created in
  BOOTSTRAP rather than in `infra/*.tf`.
- **Two models only.** The workload boundary narrows `InvokeModel`,
  `InvokeModelWithResponseStream` and `GetInferenceProfile` from `*` to:
  - the Titan embedding model;
  - the `au.` Haiku inference profile;
  - the Haiku foundation-model ARNs in both destination regions
    (`rag_model_region_arns` in `infra/rag.tf`).

  `Retrieve` and `RetrieveAndGenerate` move to their own statement,
  staying on `*` as Bedrock requires. A test pins the exact ARNs. Getting
  this wrong breaks the live `ask_docs` the moment the boundary is
  pasted, so the build checks it against the server role's own policy
  first.
- **Rate cap.** The account's Bedrock on-demand quotas for those two
  models cap spend per hour, even with stolen credentials, which makes
  them the control that keeps the worst case small. The build computes
  the worst case from the current values and lowers them through Service
  Quotas only if needed (D4).
- **The backstop doesn't re-arm itself.** Once it fires, the deny stays
  until a human resets it (BOOTSTRAP "If the backstop ever fires"). While
  it is applied, deploys still succeed, but the apply-time ingestion is
  skipped and the report says "backstop fired".

### 5.3 Workflow

Concurrency at workflow level (`group: mcp-deploy`,
`cancel-in-progress: false`), so a burst of merges collapses to the
newest run, and jobs from different runs never interleave.

Jobs:

1. **build**: no `id-token`, no environment, no AWS. `npm ci` and
   `npm run check` in `mcp/`, then `dist/` uploaded as an artifact. The
   bundle is not secret.
2. **deploy**: environment `aws`, update role. One job, so the plan file
   never leaves the runner. It holds prior state, including the API key
   values, so it is never uploaded, and `terraform show -json` output
   never reaches the log.
   1. Plan.
   2. A classifier (plain Node, no dependencies, unit-tested) reads the
      plan JSON and prints addresses and actions only. Routine means
      in-place updates whose changed attributes are all on a per-type
      allow-list: the Lambda's `source_code_hash` and the computed
      attributes that follow it (`last_modified`, `code_sha256`,
      `source_code_size`), and `tags_all` on the resource types the
      update role may tag. The test fixtures are real plans made with the
      locked provider, not hand-written JSON.
   3. Routine: apply the saved plan, then the smoke test. Anything else,
      or an AccessDenied during plan or apply, sets `route=gated` and
      writes the summary to the job summary.
3. **deploy-gated**: environment `aws-gated`, deploy role, runs when
   `route=gated` or on `workflow_dispatch` with `destroy`. It re-plans
   with the deploy role, prints the fresh summary, applies, then runs the
   smoke test. GitHub notifies the maintainer, who approves once.
   Approving trusts whatever code is on main with the deploy role, exactly
   as every approval does today (4.3).

Triggers:

- `push` to main, paths `mcp/**`, `infra/**`,
  `analysis/output/cycle_params.json` and `.github/workflows/mcp-deploy.yml`,
  excluding `**/*.md` (doc edits go through `corpus-sync.yml`).
- `workflow_dispatch` (`plan`, `apply`, `destroy`), for applying a
  repo-variable change or retrying a failed run. Apply takes the same
  route as a push. A dispatched `plan` never queues a gated apply.

`-lock-timeout=5m` on every Terraform command. `force-unlock` is in the
runbook for a run killed mid-apply. The update role can write Terraform
state; the state bucket is already versioned, which is the recovery path.

`forget` is never routine. The backstop handover forgets through the
gated path (section 9).

### 5.4 Smoke test (accident guard)

No API key enters GitHub and the update role has no `InvokeFunction`, so
the smoke test checks health, not tool output:

- `GetFunction`: state Active, last update Successful, code hash equal to
  the artifact just deployed.
- An unauthenticated POST to the public endpoint returns 403, so the
  gateway still requires a key.
- The backstop action, described in `us-east-1`: STANDBY passes, a fired
  action passes with a warning, anything else fails.

Tool behaviour is covered before merge by `mcp/` unit tests, which
exercise the handler with real MCP requests.

### 5.5 Failure handling and notification

- Pushes made through the Claude GitHub App email nobody when a run
  fails. So a failing or gated run opens (or comments on) an issue
  labelled `mcp-deploy`, assigned to the maintainer: GitHub emails it. The
  next successful deploy closes it. The jobs that need it get
  `issues: write`; `build` doesn't.
- A gated run waiting for approval blocks later deploys in the
  concurrency group. The issue says so, and so does the weekly report.
- A failed run is retried by dispatching `apply` on main, never by
  re-running the old run, which would deploy older code over a newer
  successful deploy. The weekly session retries once by itself; a second
  failure is reported, and the issue links the same dispatch.

### 5.6 Reporting (Dependabot skill)

- `wait-checks.sh` excludes `mcp-deploy` check suites. A gated deploy is
  not a CI failure.
- A new `wait-mcp-deploy.sh`:
  1. finds the newest commit on main matching the path filter;
  2. waits (polling every 60 s or more, at most 40 minutes) for a
     successful deploy of that commit or a later one;
  3. returns early, with the link, when a run waits for approval;
  4. reports "nothing to deploy" when no merge touched the paths.

  It never reports a cancelled-as-superseded run as the outcome.
- At session start the skill lists open `mcp-deploy` issues.
- The "a shipped `mcp/` fix only reaches the Lambda at the next
  `mcp-deploy` run" guidance goes.

### 5.7 GitHub settings

- `aws`: remove the required reviewer. Deployment branches stay
  "Selected branches", `main` only, no tag rule.
- `aws-gated`: new; the maintainer as required reviewer; untick "allow
  administrators to bypass"; `main` only.
- GitHub Mobile notifications for pending deployments, so an approval is
  one tap.
- Branch protection on main: decision D2.

## 6. Worst case, with this design

Attacker code on main, deployed unattended, can:

- serve wrong, hostile or stale MCP responses. Stale licensed data would
  breach the licence's 30-minute currency clause (cl 2.3), not just
  embarrass. It is fixed by reverting and letting the revert deploy;
- poison the docs corpus and trigger ingestion (Titan embeddings and
  storage, the same exposure the corpus-sync role already has);
- read the API keys and spend their monthly quotas;
- take the server role's credentials and call the two allowed models,
  or write logs, until the backstop fires;
- use the update role from any workflow on main that declares the `aws`
  environment, at any time, not only at deploy (a test pins which
  workflows declare it, but tests are attacker-controlled here). That
  includes corpus writes and ingestion.

The cost bound, per service, until the backstop fires (Budgets' reporting
lag, up to about a day, plus the time to notice):

- Bedrock: the Service Quotas rate cap on the two models.
- CloudWatch Logs ingestion and S3 requests: uncapped by quota, but cut
  off by the backstop's deny on every role that can spend. The build
  estimates the per-day exposure and records it.
- Lambda compute: the gateway quota times the unchanged 25-second
  timeout and 256 MB.
- Lambda egress: bounded by the same compute, small at this size.

The build computes the total and records it. It is a small, known
number, not an open-ended one.

It cannot create or reshape roles, change Lambda configuration, open an
endpoint, change API Gateway, call other models, or touch the backstop.
Bumps to the pinned actions in `mcp-deploy.yml` deploy unattended like
any other change on main.

An approved gated run can do more. It holds the deploy role, which can
create a new server role and point the Lambda at it, so it can step
around even a fired backstop. That is the deploy role's power today, and
it is why its runs stay behind an approval.

The same credential bound applies to every deploy today, gated or not,
because approvals are given without reading code. This design doesn't
widen it; the rate cap and the model scope narrow it.

## 7. Tests

- **Classifier**, against recorded plan JSON: code update, tag-only
  update, backstop `forget`, other `forget`, config update, IAM update,
  create, delete, replace.
- **`tests/corpus-sync-workflow.test.ts`** pins the new workflow shape:
  - triggers exactly push and dispatch, and the path filter;
  - `build` holds no `id-token`;
  - the `aws` and `aws-gated` environments appear only in mcp-deploy;
  - every job holding `id-token` declares an environment, so no job falls
    back to the main-ref subject the corpus-sync role trusts.
- **`tests/infra-boundaries.test.ts`** and its helper model:
  - the update role's exact grants, and that it has no IAM write or
    `PassRole`;
  - the human-owned backstop;
  - the narrowed workload boundary, pinned to exact model ARNs;
  - `boundary-iam` covering the kb role;
  - both roles' backstop Denies;
  - no deploy resource pattern matching `bbb-backstop-*` or
    `bbb-mcp-update`;
  - trust conditions using `StringEquals`, never `StringLike`;
  - the new role, policy and boundary counts.
- These tests catch mistakes. They are not controls (section 4).

## 8. Docs cascade

The repo describes its own deploy model in many places, and several of
these docs are in the `ask_docs` corpus. Everything below lands in the same
PR as the build. No follow-up docs PR. The list comes from two full-repo
greps during review; the build re-runs the grep before merge.

Corpus docs:

- **`infra/BOOTSTRAP.md`:**
  - intro ("everything here happens exactly once", "two roles GitHub
    Actions assumes", "a workflow run you have personally approved",
    "Step 3 is one paste");
  - the OIDC subject comments, and the `CORPUS_SYNC_SUB` derivation, which
    must take a fixed base rather than strip `:environment:aws` (a
    re-run with a different `GITHUB_SUB` would break corpus-sync);
  - 3b trust and policy (the gated role);
  - new 3d (backstop) and 3e (update role), appended so existing section
    names and numbers stay stable;
  - Step 4 (two environments, rewritten gate callout);
  - the RAG update section;
  - "If the backstop ever fires" (new names, both roles);
  - key rotation (now gated);
  - a new "Update for auto-deploy" migration section;
  - Decommissioning.
- **`mcp/README.md`:**
  - deploys and security posture (reviewer, who can read the keys, who
    can manage the budget);
  - cost guards;
  - key rotation;
  - Decommission ("still gated by the same human approval",
    "`terraform destroy` removes the entire footprint").
- **`docs/mcp-rag-design.md`:** a dated design, so it gets dated notes
  where it describes the backstop in Terraform, the gated workflow and
  "human-approved runs", not a rewrite.
- **`README.md`:** "`budget_limit_usd` in the Terraform stack".
- **`docs/deploy-runbook.md`:** changing `BBB_STALENESS_MINUTES` for the
  MCP server is a gated deploy.

Other docs:

- **`CLAUDE.md`:**
  - MCP subproject section ("deploys ONLY via mcp-deploy, human-approval
    gated", "the one ungated exception", "`terraform destroy` = full
    decommission");
  - the wildcard paragraph, whose rule (no wildcard deploy policies
    unless approval-gated) still holds;
  - the permanent exit path.
- **`PLAN.md`:** a new row recording the reversal of the 2026-08-24
  decision. Older rows stay as history.
- **`.claude/skills/process-dependabot-prs/SKILL.md`:** lines 3, 23, 48,
  58 and 61-63; `scripts/wait-checks.sh`; the new wait script.

Code and comments:

- `.github/workflows/mcp-deploy.yml`, rewritten.
- `.github/workflows/corpus-sync.yml`: the header contrast and "cannot
  touch the deployed stack".
- `mcp/scripts/sync-corpus.sh` header.
- `infra/`:
  - `rag.tf`: backstop resources become `removed` blocks; boundary locals
    and comments;
  - `lambda.tf`: the `depends_on` on the deny policy and the destroy
    comment;
  - `variables.tf`: `budget_limit_usd` and `budget_alert_email` go, with
    the "firm backstop" comment on `monthly_quota`;
  - `versions.tf`: the out-of-stack resource list;
  - `outputs.tf` comment.
- Tests, beyond section 7:
  - `corpus-sync-workflow.test.ts`: "the destroy action stays out of
    reach of push events", "only the human-dispatched, environment-gated
    deploy workflow", "only the two known workflows";
  - `infra-boundaries.test.ts`: "behind a human approval gate", "the one
    role that runs ungated".

Second-order items:

- **Counts:**
  - "two boundaries" stays two;
  - "three roles Terraform creates" becomes two;
  - "two hand-made roles" becomes four.
- **Section names** stay put: "Update for the ungated corpus sync",
  "Decommissioning", 3a and 3c, and the cost-guard layer numbers.
- **Exit path (licence cl 4.6).** A later merge could rebuild a
  decommissioned stack, so deleting both deploy roles becomes a required
  decommissioning step. So do detaching the backstop policy in CloudShell
  before `destroy` and deleting the backstop resources after.

This document stays out of the corpus (decision D3). Its threat analysis
names current weaknesses, which `ask_docs` would serve verbatim. The
corpus docs state each role's bound instead.

## 9. Build and migration

The live account stays protected throughout. Additive first, then
forget, then narrow:

1. **PR** with all of the above. Checks run locally, then CI.
2. **Maintainer, CloudShell, before merge** (additive, idempotent):
   - create the update role;
   - create the `bbb-backstop-*` resources (a second backstop, armed
     alongside the old one);
   - narrow the workload boundary;
   - widen `boundary-iam` to the kb role;
   - add the `aws-gated` subject to the deploy role's trust, keeping
     `aws` for now.
3. **Maintainer, console and GitHub:**
   - read the two Bedrock quota values, and lower them only if D4 says
     to;
   - create `aws-gated`;
   - add the `AWS_UPDATE_ROLE_ARN` variable;
   - branch protection on main (D2).
4. **Merge.** `aws` still has its reviewer, so the push run asks for
   approval of the update-role job. Its plan refresh can't read the old
   backstop, so it routes to `deploy-gated`, a second approval, which
   forgets the old backstop. Two taps, once.
5. **Maintainer, CloudShell:**
   - delete the old backstop resources, in order:
     1. detach the old `bbb-mcp-bedrock-deny` if it was ever applied;
     2. delete the budget action, then the budget;
     3. delete the old budgets role's inline policy, then the role;
     4. delete the old deny policy;
   - replace the deploy role's policy with the narrowed one plus the
     Denies;
   - rewrite its trust to the `aws-gated` subject only.
6. **Maintainer, GitHub:** remove the reviewer from `aws`.
7. **Verify** with a dispatched `apply` (a no-op, which should run
   unattended to "nothing to change"), and record the dated events in
   PLAN.md.

Rollback: re-adding the reviewer to `aws` stops unattended deploys at once
(each run then needs approval). Never revert the backstop handover
without `import` blocks, or Terraform will try to create resources that
already exist.

## 10. Maintainer experience

| Week | Maintainer actions |
| :- | :- |
| Normal Wednesday (bumps, code) | None. The report says "MCP deployed at <sha>" |
| A gated change (IAM, config, new resource) | One tap on the notification |
| A provider bump needs a write the update role lacks | One tap (it routes to gated). Widening the update role is optional |
| A transient failure | None: the weekly session retries once |
| A persistent failure | Read the report or issue; a fix PR, or one dispatch of `apply` on main |

## 11. Decisions (maintainer, 2026-11-11)

- **D1. Gated runs are queued by the merge and approved with one tap.**
  This is the existing security model for these rare runs. Considered
  and not taken: limiting gated runs to maintainer dispatch, enforced by
  customising the OIDC subject claim repo-wide.
- **D2. Branch protection on main:** "enforce for admins" on, and a pull
  request required (0 approvals, so a single maintainer and the
  Dependabot session can still merge). Set during migration.
- **D3. This document stays out of the `ask_docs` corpus** (section 8).
- **D4. Bedrock rate cap: measure first.** The build computes the
  worst-case figure from the account's current Service Quotas values for
  the two models. The quotas are lowered only if that figure exceeds the
  monthly budget; either way the figure is recorded.

## Doc discipline for this document

During review this is a draft. Before merge it is rewritten as post-merge
truth: decisions recorded as dated events, the build steps as what
happened and what the maintainer ran. Status lives in PLAN.md.
