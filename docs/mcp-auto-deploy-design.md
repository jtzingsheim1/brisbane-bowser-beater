# MCP auto-deploy: design record

The design for deploying the MCP stack (`mcp/`, `infra/`) on merge to
main. Drafted 2026-11-11, reviewed in three rounds by fresh independent
reviewers, approved by the maintainer the same day, then built and merged
in 2026-11 (PR #188). This document records the problem, the threat
analysis, the design as built, the decisions as dated events and where
the build departed from the approved draft. Status lives in `PLAN.md`;
the operator steps live in `infra/BOOTSTRAP.md`, "Update for auto-deploy".

It stays out of the `ask_docs` corpus (decision D3): its threat analysis
names weaknesses that the corpus docs instead state as bounds.

## 1. Problem (as of 2026-11-11)

Every change to the MCP stack reached AWS only through
`.github/workflows/mcp-deploy.yml`, in two manual steps: the maintainer
dispatched the workflow, then approved the pending run on the `aws`
GitHub environment, which had a required reviewer.

The project is in caretaker mode. The routine work is the weekly
Dependabot batch, run by a Claude session the maintainer starts and skims.
From `git log` (2026-08-01 to 2026-11-11): 44 of 72 commits on main
touched `mcp/` or `infra/`, 33 of them Dependabot, and every weekly batch
since late August included at least one MCP or Terraform bump. So the
stack changed every week, and each change waited for two manual steps.

Deploys also lagged main. Merged MCP changes sat undeployed until someone
ran the workflow. `analysis/output/cycle_params.json` is bundled into the
Lambda at build time (`mcp/src/cycle-model.ts`), so a quarterly re-fit
left `get_cycle_model` serving the old fit until a manual deploy.

## 2. History

- 2026-08-24, PR #108: docs-corpus publishing became ungated, under a role
  (`bbb-mcp-corpus-sync`) that can only write the corpus bucket and start
  ingestion. `infra/BOOTSTRAP.md` section 3c records the reasoning: the
  merge was already the editorial decision, and an ungated run is
  acceptable when its role can do little.
- 2026-08-24, same PR: ungated code and infra deploys were considered and
  dropped: "the doc toil that motivated it is gone and the gate costs
  nothing" (`PLAN.md`).
- 2026-11-11: with the project in caretaker mode, the gate cost two
  manual steps every week and stale deploys had become a real failure
  mode. This design reversed the 2026-08-24 decision for one narrow kind
  of deploy, on the section 3c reasoning.

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

AWS trusts a GitHub OIDC subject: the repo plus a GitHub environment, and
both deploy environments are limited to `main`. So whoever can put code on
main controls what a push-triggered deploy runs:

- the maintainer;
- Claude sessions, through the GitHub tools they use, which can merge PRs
  and dispatch workflows. Probed 2026-11-11: Anthropic's documented
  permission list for the app says Actions read only, but a dispatch of a
  workflow to a nonexistent ref passed authorisation and failed only on
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
   was equally true of the approvals given before this design. So the
   real cost bound is what the server role may call (5.2), at the rate
   AWS allows (5.2), until the backstop fires.

## 5. Design, as built

### 5.1 Two roles

| | `bbb-mcp-update` (new) | `bbb-mcp-deploy` (existing) |
| :- | :- | :- |
| Trusted by | `environment:aws` (no reviewer, main only) | `environment:aws-gated` (required reviewer, admin bypass off, main only) |
| Runs | Code-only deploys, unattended | Everything else, after one approval |
| Writes | `lambda:UpdateFunctionCode` on exactly `function:bbb-mcp-server`; tag and untag on the Lambda, corpus bucket, vector store and knowledge base (never IAM or API Gateway tags); corpus object put/delete; start ingestion; Terraform state | Its earlier statements, minus everything budget-related |
| Reads | `Get*`, `List*`, `Describe*` on stack resources (`logs:DescribeLogGroups` on `log-group:*`, which it requires; `s3:ListBucket` on the corpus bucket), `apigateway:GET`, IAM reads on the stack roles, budget and action reads on `bbb-backstop-*` | Its earlier reads, plus budget and action reads on `bbb-backstop-*` |
| Policy | Inline, on a role outside every deploy-policy pattern (BOOTSTRAP 3e) | Inline (BOOTSTRAP 3b) |

Why reads are wildcards and writes are not: Terraform's refresh calls many
read APIs per resource, and provider bumps add new ones. Wildcard reads
keep provider bumps from failing the unattended path, and reads change
nothing. One read matters: API Gateway reads return the API keys, so the
update role can read them. A leaked key spends that key's monthly quota,
which the update role can't change. `mcp/README.md` states who can read
the keys accordingly.

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
  - Lambda configuration changes (a new environment variable, or a new
    `BBB_STALENESS_MINUTES` value);
  - replacements;
  - destroy.

  Each of those happened at most a few times between August and
  November 2026, mostly during build-out.

### 5.2 Cost backstop and model scope

- **Human-owned backstop.** The budget, its action, the deny policy and
  the action's role moved out of Terraform into `infra/BOOTSTRAP.md`
  section 3d. They are named `bbb-backstop-*`, outside every
  deploy-policy pattern. Both deploy roles carry explicit Denies on every
  write to them, plus a Deny on `iam:DetachRolePolicy` conditioned on
  `iam:PolicyARN` matching the deny policy (a detach names the role, not
  the policy, so a resource-keyed Deny alone would not stop it). Reads
  stay allowed, for the smoke test. A test asserts no deploy statement's
  resource matches the backstop names.
- **Every role that can spend is covered.** The deny policy covers
  `bedrock:*`, `logs:PutLogEvents` and `s3:PutObject`. The action attaches
  it to the server role, the kb role, the update role and the corpus-sync
  role. Before this design it covered only Bedrock on the server role.
  `bbb-mcp-boundary-iam` stays the backstop role's boundary and widened to
  those four roles. The parity test models a role created in BOOTSTRAP as
  well as those in `infra/*.tf`.
- **Two models only.** The workload boundary narrowed `InvokeModel`,
  `InvokeModelWithResponseStream` and `GetInferenceProfile` from `*` to:
  - the Titan embedding model;
  - the `au.` Haiku inference profile;
  - the Haiku foundation-model ARNs in both destination regions
    (`rag_model_region_arns` in `infra/rag.tf`).

  `Retrieve` and `RetrieveAndGenerate` moved to their own statement,
  staying on `*` as Bedrock requires. A test pins the exact ARNs against
  the locals in `infra/rag.tf`. Getting this wrong breaks the live
  `ask_docs` the moment the boundary is pasted, so the migration checks
  `ask_docs` straight after the paste.
- **Rate quotas.** The account's Bedrock on-demand quotas for those two
  models put a per-minute ceiling on model spend, whichever role holds the
  credentials. They were read at migration and left at the AWS defaults
  (D4).
- **The backstop doesn't re-arm itself.** Once it fires, the deny stays
  until a human resets it (BOOTSTRAP "If the backstop ever fires":
  reverse the action, which detaches through the action's own role,
  with a manual detach as the fallback). While
  it is applied, the update role cannot write Terraform state, so every
  deploy hits AccessDenied on the unattended path and routes to the gated
  one: one approval per deploy until the reset. The deploy role is not a
  target, so gated deploys still apply. The smoke test reports the fired
  state, and the apply-time corpus sync is skipped. (The approved draft
  said deploys still succeed unattended while the deny is applied; see
  section 13.)

### 5.3 Workflow

Concurrency at workflow level (`group: mcp-deploy`,
`cancel-in-progress: false`), so a burst of merges collapses to the
newest pending run, and jobs from different runs never interleave. A
dispatched `plan` runs in its own group (`mcp-deploy-plan`): a group holds
one pending run, so a plan sharing the deploy group could cancel a push
deploy queued behind a running one. A plan applies nothing, so it may run
beside a deploy; Terraform's state lock keeps their state access apart.
Apply and destroy dispatches share the deploy group. The
run name carries the action (`Deploy MCP stack (<action>)`, `push` for a
push), because the runs API does not expose dispatch inputs and the
Dependabot skill's wait script needs to tell dispatched plan and destroy
runs apart.

Jobs:

1. **build**: no `id-token`, no environment, no AWS. `npm ci` and
   `npm run check` in `mcp/`, then `dist/` uploaded as an artifact,
   kept for 30 days because a gated run can wait that long. The bundle is
   not secret.
2. **deploy**: environment `aws`, update role. One job, so the plan file
   never leaves the runner. It holds prior state, including the API key
   values, so it is never uploaded, and `terraform show -json` output
   never reaches the log.
   1. Plan. An AccessDenied here routes to gated.
   2. A classifier (`infra/scripts/classify-plan.mjs`, plain Node, no
      dependencies, unit-tested) reads the plan JSON and prints addresses,
      actions and attribute names only. Routine means in-place updates
      whose changed attributes are all on a per-type allow-list: the
      Lambda's `source_code_hash` and the computed attributes that follow
      it (`last_modified`, `code_sha256`, `source_code_size`, plus
      `qualified_arn`, `qualified_invoke_arn` and `version` only as
      unknown-after-apply churn), and `tags_all` on the resource types
      the update role may tag. A plan that changes outputs only is
      routine; one with no changes is `noop`. A resource change with a
      `previous_address` (a move) is gated whatever its actions, checked
      before them, so an update that also moves never passes as routine.
      A type with write-only attributes never joins the allow-list:
      plan JSON shows them as null, so their changes are invisible. A
      plan file that does not parse fails the step with a fixed message
      that quotes none of its content.
   3. Routine: apply the saved plan, then the smoke test. Noop: the smoke
      test only. Anything else, or an AccessDenied during plan or apply,
      sets `route=gated` and writes the summary to the job summary. A
      dispatched `plan` prints the route it would take and stops.
3. **deploy-gated**: environment `aws-gated`, deploy role, runs when
   `route=gated` or on a dispatched `destroy`. It re-plans with the deploy
   role, prints the fresh classification, applies, shows the outputs and
   runs the smoke test. GitHub notifies the maintainer, who approves once.
   Approving trusts whatever code is on main with the deploy role, exactly
   as every approval did before this design (4.3). It then syncs the docs
   corpus only when its plan created or changed the knowledge base, its
   data source, the corpus bucket or the vector store, and the backstop
   has not fired.
4. **notify-gated**: runs beside `deploy-gated` while it waits, and opens
   or comments on the `mcp-deploy` issue (5.5). `issues: write`, no AWS.
   A dispatched `destroy` waiting for approval opens no issue: the
   maintainer started it.
5. **report**: after every other job, `notify-gated` included, so a
   rejected approval cannot race `notify-gated` into a second issue and a
   failed notification is reported. On a failure it opens or comments on
   the issue, and after a successful deploy it closes open ones.
   `issues: write`, no AWS.

Routine deploys never sync the corpus: a routine plan can change only the
Lambda's code and tags, neither of which changes what the knowledge base
should hold, and doc edits publish through `corpus-sync.yml`.

Triggers:

- `push` to main, paths `mcp/**`, `infra/**`,
  `analysis/output/cycle_params.json` and `.github/workflows/mcp-deploy.yml`,
  excluding `**/*.md` (doc edits go through `corpus-sync.yml`).
- `workflow_dispatch` (`plan`, `apply`, `destroy`), for applying a
  repo-variable change, retrying a failed run, previewing or
  decommissioning. Apply takes the same route as a push. A dispatched
  `plan` never queues a gated apply.

`-lock-timeout=5m` on every Terraform command. `force-unlock` is in the
runbook for a run killed mid-apply. The update role can write Terraform
state; the state bucket is versioned, which is the recovery path.

`forget` is never routine. The backstop handover forgot the old
Terraform-managed backstop through the gated path (section 9).

### 5.4 Smoke test (accident guard)

No API key enters GitHub and the update role has no `InvokeFunction`, so
the smoke test (`infra/scripts/smoke.sh`) checks health, not tool output:

- `GetFunction`: state Active, last update Successful, code hash equal to
  the package Terraform built from this run's bundle.
- An unauthenticated POST to the public endpoint returns 403, so the
  gateway still requires a key.
- The backstop action, described in `us-east-1`: STANDBY passes, a fired
  action passes with a warning (and tells the workflow to skip the corpus
  sync), anything else fails.

Tool behaviour is covered before merge by `mcp/` unit tests, which
exercise the handler with real MCP requests.

### 5.5 Failure handling and notification

- Pushes made through the Claude GitHub App email nobody when a run
  fails. So a failing or gated run opens (or comments on) the issue "MCP
  deploy needs attention", labelled `mcp-deploy` and assigned to the
  repository owner, so GitHub emails it (if the assignment is refused,
  the issue is opened unassigned rather than not at all). A later
  successful deploy closes it. Only `notify-gated` and `report` hold `issues: write`, and neither
  holds AWS credentials.
- A gated run waiting for approval blocks later deploys in the
  concurrency group. The issue says so, and so does the weekly report.
- A failed run is retried by dispatching `apply` on main, never by
  re-running the old run, which would deploy older code over a newer
  successful deploy. The weekly session retries once by itself; a second
  failure is reported, and the issue names the same dispatch.

### 5.6 Reporting (Dependabot skill)

- `wait-checks.sh` excludes `mcp-deploy` check suites. A gated deploy is
  not a CI failure.
- `wait-mcp-deploy.sh`:
  1. finds the newest commit on main matching the path filter;
  2. waits (polling every 60 s or more, at most 40 minutes) for a
     successful deploy of that commit or a later one;
  3. returns early, with the link, when a run waits for approval;
  4. reports "nothing to deploy" when no merge touched the paths.

  It never reports a cancelled-as-superseded run as the outcome. A
  cancelled run counts as superseded only when a newer deploying run (a
  push or a dispatched `apply`) exists; a later dispatched `plan` or
  `destroy` supersedes nothing.
- At session start the skill lists open `mcp-deploy` issues.
- The "a shipped `mcp/` fix only reaches the Lambda at the next
  `mcp-deploy` run" guidance went.

### 5.7 GitHub settings

- `aws`: no required reviewer. Deployment branches "Selected branches",
  `main` only, no tag rule.
- `aws-gated`: the maintainer as required reviewer; "allow administrators
  to bypass" unticked; `main` only.
- GitHub Mobile notifications for pending deployments, so an approval is
  one tap.
- Branch protection on main per D2.

## 6. Worst case

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

- Bedrock: the account's on-demand rate quotas on the two models.
- CloudWatch Logs ingestion and S3 requests: uncapped by quota, but cut
  off by the backstop's deny on every role that can spend.
- Lambda compute: the gateway quota times the unchanged 25-second
  timeout and 256 MB.
- Lambda egress: bounded by the same compute, small at this size.

So spend is rate-limited per minute and ended by the backstop, not
open-ended.

It cannot create or reshape roles, change Lambda configuration, open an
endpoint, change API Gateway, call other models, or touch the backstop.
Bumps to the pinned actions in `mcp-deploy.yml` deploy unattended like
any other change on main.

An approved gated run can do more. It holds the deploy role, which can
create a new server role and point the Lambda at it, so it can step
around even a fired backstop. That was the deploy role's power before
this design too, and it is why its runs stay behind an approval.

The same credential bound applied to every deploy before this design,
gated or not, because approvals were given without reading code. This
design doesn't widen it; the model scope narrows it.

## 7. Tests

- **Classifier** (`tests/classify-plan.test.ts`), against plan JSON
  fixtures in `tests/fixtures/plans/`: code update, tag-only update (and
  a log-group tag, which gates), no-op, outputs only, backstop `forget`,
  other `forget`, import, move, config update, IAM update, knowledge-base
  update, create, delete, and both replace orders. The fixtures are
  hand-written to Terraform's plan JSON format (section 13).
- **`tests/corpus-sync-workflow.test.ts`** pins the workflow shape:
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
  - `boundary-iam` covering the four backstop targets;
  - both roles' backstop Denies;
  - no deploy resource pattern matching `bbb-backstop-*` or
    `bbb-mcp-update`;
  - trust conditions using `StringEquals`, never `StringLike`;
  - the role, policy and boundary counts.
- These tests catch mistakes. They are not controls (section 4).

## 8. Docs cascade

The repo describes its own deploy model in many places, and several of
those docs are in the `ask_docs` corpus. All of them changed in the same
PR as the build, from a full-repo grep re-run before merge:

- corpus docs: `infra/BOOTSTRAP.md` (intro, OIDC subjects, 3b, new 3d
  and 3e, Step 4, "If the backstop ever fires", key rotation, the "Update
  for auto-deploy" migration section, Decommissioning), `mcp/README.md`
  (deploys, security posture, cost guards, key rotation, Decommission),
  `docs/mcp-rag-design.md` (dated "Superseded 2026-11" notes, not a
  rewrite), `README.md` and `docs/deploy-runbook.md`;
- `CLAUDE.md` (MCP subproject section, the wildcard paragraph, the
  permanent exit path) and a new `PLAN.md` row, older rows kept as
  history with dated "superseded" markers;
- the Dependabot skill and its scripts;
- comments in the workflows, `mcp/scripts/sync-corpus.sh`, `infra/*.tf`
  and the tests.

Section names stayed put ("Update for the ungated corpus sync",
"Decommissioning", 3a to 3c, the cost-guard layer numbers). Counts that
changed: Terraform creates two roles, and BOOTSTRAP hand-makes four
(update, deploy, corpus-sync, backstop action); the boundaries stay two.

Decommissioning gained required steps (licence cl 4.6: a later merge must
not rebuild a decommissioned stack): detach the backstop deny in
CloudShell before `destroy` (required if it has fired, since IAM will
not delete a role with it attached; the role and policy deletions also
detach first), delete both deploy roles and disable the
workflow after it, then delete the backstop resources.

## 9. Migration

The runbook is `infra/BOOTSTRAP.md`, "Update for auto-deploy". The live
account stays protected throughout: additive first, then forget, then
narrow. What the maintainer runs:

0. **Before Paste A, CloudShell**: read the old budget's live limit and
   month-to-date actual spend. A new action on a budget already past
   100% fires within hours, with a wider deny than the old one, so
   `BACKSTOP_LIMIT_USD` must sit above month-to-date spend (or Paste A
   waits for the month to roll over).
1. **Before merge, CloudShell, Paste A**: the Step 3 script with
   `DEPLOY_ROLE_STAGE="transition"`. It creates the update role, arms the
   `bbb-backstop-*` resources alongside the old backstop, narrows the
   workload boundary, widens `boundary-iam`, and adds the `aws-gated`
   subject to the deploy role's trust while keeping `aws` and the deploy
   role's policy. Then one `ask_docs` question to confirm the narrowed
   boundary.
2. **Before merge, console and GitHub**: read the two Bedrock quota
   values (D4); create `aws-gated`; add the
   `AWS_UPDATE_ROLE_ARN` variable; protect main (D2).
3. **Merge.** `aws` still has its reviewer, so the push run asks for
   approval of the update-role job. It routes to `deploy-gated` either
   way: its plan hits AccessDenied reading the old backstop, or the
   classifier gates the `forget` actions. That is a second approval,
   which
   forgets the old backstop (`removed` blocks in `infra/rag.tf`). Two
   taps, once.
4. **After merge, CloudShell, Paste B**, only once the gated run has
   succeeded and listed the five `forget` lines; the paste re-checks the
   Terraform state for them and stops if any remains. It deletes the old
   backstop (the budget action first, so it cannot fire mid-cleanup, then
   the budget; then the old deny's attachments, if it was ever applied;
   the old action role's policy, then the role; the old deny policy),
   then re-paste the Step 3 script with
   `DEPLOY_ROLE_STAGE="final"`, which replaces the deploy role's policy
   with the narrowed one plus the Denies and rewrites its trust to the
   `aws-gated` subject only.
5. **GitHub**: remove the reviewer from `aws`; delete the `ALERT_EMAIL`
   repository variable, which nothing reads any more.
6. **Verify** with a dispatched `apply` (a no-op, which should run
   unattended to "no changes"), and record the dated events in `PLAN.md`.

Rollback: adding a reviewer back to `aws` stops unattended deploys at once
(each run then needs approval). Never move the backstop back into
Terraform without `import` blocks, or Terraform will try to create
resources that already exist.

## 10. Maintainer experience

| Week | Maintainer actions |
| :- | :- |
| Normal week (bumps, code) | None. The report says the MCP deploy succeeded, with the SHA |
| A gated change (IAM, config, new resource) | One tap on the notification |
| A provider bump needs a write the update role lacks | One tap (it routes to gated). Widening the update role is optional |
| The backstop has fired | One tap per deploy until it is reset |
| A transient failure | None: the weekly session retries once |
| A persistent failure | Read the report or issue; a fix PR, or one dispatch of `apply` on main |

## 11. Decisions (maintainer, 2026-11-11)

- **D1. Gated runs are queued by the merge and approved with one tap.**
  The existing security model for these rare runs. Considered and not
  taken: limiting gated runs to maintainer dispatch, enforced by
  customising the OIDC subject claim repo-wide.
- **D2. Branch protection on main:** "enforce for admins" on, and a pull
  request required (0 approvals, so a single maintainer and the
  Dependabot session can still merge). Set during migration.
- **D3. This document stays out of the `ask_docs` corpus.** Its threat
  analysis names weaknesses, which `ask_docs` would serve verbatim. The
  corpus docs state each role's bound instead.
- **D4. Bedrock rate quotas: left at the AWS defaults.** The plan was to
  read the two models' quotas at migration and lower them if needed. They
  were read on 2026-11-11, and the maintainer accepted them as they are.

## 12. Review history

All on 2026-11-11, each round with fresh independent reviewers.

- **Round 1** reviewed v1, one narrowed deploy role for every deploy
  (IAM and GitHub security, operations, docs cascade). It failed: a role
  able to create roles, pass them to Lambda or write trust policies can
  step around any cost backstop. v2 was a rewrite: routine deploys under
  a new update-only role, everything else under the existing deploy role
  in a reviewer-gated environment, a human-owned backstop outside both
  roles' reach, and dependency code built in a job that cannot mint an
  AWS token.
- **Round 2** reviewed v2. The two-role shape held, but the reviewers
  broke its worst-case bound (v2's update role could still change the
  Lambda's configuration and pass the server role) and several build
  details. v3 narrowed the unattended role to replacing the Lambda's code
  (no configuration, `PassRole` or invoke), added the Bedrock rate cap and
  model scope, kept plan and apply in one job, moved to workflow-level
  concurrency, and fixed reporting and migration gaps.
- **Round 3** reviewed v3 and judged it buildable with policy-text fixes,
  which v4 applied: backstop reads allowed for the smoke test, the detach
  Deny keyed on the policy ARN, the deny policy extended to log and S3
  writes on every role that can spend, a per-service cost bound, model
  scope keeping the streaming and inference-profile actions, no routine
  `forget`, failure issues pointing at a dispatch rather than a re-run,
  and the teardown order for the old backstop. The maintainer then
  recorded D1 to D4 and the dispatch probe, and approved v4.

## 13. Build deviations from the approved draft

The build is the truth where it differs from v4. Each change below is
reflected in the sections above.

- **Issue writing moved out of the deploy jobs.** v4 gave `issues: write`
  to the jobs that needed it. The build puts it in two jobs,
  `notify-gated` and `report`, that hold no AWS credentials, so no job
  holds both an AWS session and a GitHub write token.
- **Apply-time corpus sync narrowed.** v4 kept the earlier sync after
  every apply. The build syncs only on gated applies whose plan creates
  or changes the knowledge base, its data source, the corpus bucket or
  the vector store. Routine code deploys never sync; `corpus-sync.yml`
  handles doc changes.
- **Classifier fixtures are hand-written.** v4 called for real plans made
  with the locked provider. The fixtures are hand-written to Terraform's
  plan JSON format, to be refreshed from a real plan.
- **A fired backstop sends deploys to the gated path.** The deny policy
  denies `s3:PutObject` on `*`, which also blocks the update role's
  Terraform state writes. v4 said deploys still succeed while the deny is
  applied; in the build, unattended deploys hit AccessDenied and route to
  the gated path, where the deploy role (not a backstop target) still
  applies. After a fire, each deploy needs one approval until the
  backstop is reset.
- **Classifier routes.** Besides routine and gated, the build has `noop`
  (smoke test only), routes an outputs-only plan as routine, allows the
  Lambda's version attributes only as unknown-after-apply churn, and
  gives a dispatched `plan` its own route that applies nothing.
- **Run name.** `Deploy MCP stack (<action>)`, since the runs API does
  not expose dispatch inputs and the wait script must tell dispatched
  plan and destroy runs apart.
- **Bootstrap shape.** One Step 3 script with a `DEPLOY_ROLE_STAGE`
  switch (`transition` for Paste A, `final` otherwise) rather than
  separate pastes. Section 3d (backstop) skips on a fresh account until
  the stack's first apply creates the roles it targets, so Step 3 is
  pasted once more after that apply; 3e (update role) runs before 3d.
  The migration section is "Update for auto-deploy", and Step 4's items
  are numbered 4.1 to 4.4 (the two environments, branch protection, the
  variables).
- **Backstop settings.** The alert email and monthly limit live in the
  Step 3 script (`ALERT_EMAIL`, `BACKSTOP_LIMIT_USD`), no longer
  Terraform inputs, so `budget_limit_usd` and `budget_alert_email` went.
