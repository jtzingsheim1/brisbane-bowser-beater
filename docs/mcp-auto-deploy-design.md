# MCP auto-deploy: design and build plan

DRAFT v2, 2026-11-11. v1 went through three independent reviews (IAM and
GitHub security, operations, docs cascade); v2 is a rewrite around what
they found, not a patch. Before merge this document is rewritten as
post-merge truth (see the last section).

## 1. Problem

Every change to the MCP stack (`mcp/`, `infra/`) reaches AWS only through
`.github/workflows/mcp-deploy.yml`, in two manual steps: the maintainer
dispatches the workflow, then approves the pending run on the `aws` GitHub
environment, which has a required reviewer.

The project is in caretaker mode. The routine work is the weekly
Dependabot batch, run by a Claude session the maintainer starts and skims.
Measured from `git log` (2026-08-01 to 2026-11-11): 44 of 72 commits on
main touched `mcp/` or `infra/`, 33 of them Dependabot, and every weekly
batch since late August included at least one MCP or Terraform bump. So
the stack changes every week, and each change waits for two manual steps.

Deploys also lag main. Merged MCP changes sit undeployed until someone
runs the workflow. `analysis/output/cycle_params.json` is bundled into the
Lambda at build time (`mcp/src/cycle-model.ts`), so a quarterly re-fit
leaves `get_cycle_model` serving the old fit until a manual deploy.

## 2. History and what changed

- PR #108 (2026-08-24) made docs-corpus publishing ungated:
  `corpus-sync.yml` runs on any push to main that touches a corpus doc,
  under a role (`bbb-mcp-corpus-sync`) that can only write the corpus
  bucket and start ingestion. The reasoning recorded in
  `infra/BOOTSTRAP.md` section 3c: the merge was already the editorial
  decision, and what makes an ungated run acceptable is how little its role
  can do.
- The same PR considered ungated code and infra deploys and dropped the
  idea, because "the doc toil that motivated it is gone and the gate costs
  nothing" (PLAN.md).
- What changed since: the project moved to caretaker mode, where the
  gate is a weekly cost, not a rare one, and stale deploys are a real
  failure mode (above). This design reverses the 2026-08-24 decision for
  routine deploys only, using the section 3c reasoning: an ungated run is
  acceptable when its role is narrow.

## 3. Goals and non-goals

Goals:

- A merge to main that changes the MCP stack deploys it, with no step
  from the maintainer, whenever the change is routine (code, config,
  dependency and provider bumps).
- Changes that are not routine (IAM, new or deleted resources,
  replacements, destroy) stop at one approval, which arrives as a
  notification with the plan summary and needs one tap.
- The weekly report confirms the AWS deploy, as it already confirms the
  Vercel deploy.
- The worst case of an unattended deploy is bounded by IAM, not by
  workflow code, and the bound is stated honestly.

Non-goals:

- No autonomous loop: the maintainer starts every session.
- No change to the website's deploy (Vercel on push to main).

## 4. Threat model

AWS trusts a GitHub OIDC subject: the repo plus a GitHub environment. The
`aws` environment is limited to `main`. So whoever can put code on main
controls what a push-triggered deploy runs. Today that is:

- the maintainer;
- Claude sessions, through the Claude GitHub App, which can merge PRs. Per
  Anthropic's documented permissions the app has Actions read only, so it
  can merge but cannot dispatch workflows (to confirm in the build);
- anything holding a write token, or admin access: branch protection on
  main requires the `check` and `analyze` checks but has `enforce_admins`
  off and no required review, so an admin token can push straight to main;
- dependency code: `npm ci` and tests run inside the deploy job today, and
  that job holds `id-token: write`, so an install script could mint a
  deploy token;
- prompt injection: the Dependabot session reads untrusted text (PR
  bodies, changelogs) while it holds merge rights. The skill's rule that
  it only merges PRs whose every commit is Dependabot's is the control.

Two conclusions shape the design:

1. Workflow code on main is attacker-controlled in this model, and so are
   the tests. So a plan check or smoke test in the workflow is an
   accident guard, never a security control. Only IAM, and which role a
   job can assume, enforce anything.
2. v1 tried to bound an ungated deploy by narrowing the existing deploy
   role. The reviews showed that can't work: a role that can create
   roles, pass them to Lambda and write trust policies can step around any
   backstop (create a new server role the backstop doesn't name; trust a
   role to an outside account, which survives a revert). So the ungated
   path gets its own role, which can update the stack and cannot change
   its shape.

## 5. Design

### 5.1 Two roles

| | `bbb-mcp-update` (new) | `bbb-mcp-deploy` (existing) |
| :- | :- | :- |
| Trusted by | `environment:aws` (no reviewer, main only) | `environment:aws-gated` (new; required reviewer, main only) |
| Runs | Routine deploys, unattended | Everything else, after one approval |
| IAM | Read only, plus `iam:PassRole` on exactly `role/bbb-mcp-server-exec`, to Lambda only | Today's statements, minus everything budget-related |
| Lambda | Get/List, `UpdateFunctionCode`, `UpdateFunctionConfiguration` on exactly `function:bbb-mcp-server` | Today's `lambda:*` on `bbb-mcp-*` |
| API Gateway | `GET` only | Today's `apigateway:*` |
| S3 corpus bucket | Object read/write, bucket config read only | Today's `s3:*` |
| S3 Vectors, Bedrock KB | Get/List, start and poll ingestion | Today's |
| Logs | Read only | Today's |
| Terraform state | Read/write | Read/write |
| Budgets | `ViewBudget` and describe the backstop action (smoke test) | None |

Both roles get explicit Denies on the backstop's ARNs (5.2). The update
role's statements are an allow-list with no wildcards, so it can't create
a function, add a function URL or resource-policy permission, set
provisioned concurrency, create a role or API, or touch a bucket policy.

What the update role covers in practice: Lambda code changes (every
Dependabot `mcp/` bump, every `cycle_params.json` re-fit), Lambda
configuration (environment variables, memory, timeout), provider bumps
that change nothing, and the apply-time corpus sync. From the history,
that is every MCP deploy since August except the ones that added new
resources (the RAG stack, the second API key).

### 5.2 Cost backstop: human-owned, out of both roles' reach

The budget, its action, the Bedrock deny policy and the action's role
move out of Terraform into `infra/BOOTSTRAP.md` (a new section 3d),
created once by a human, like the permissions boundaries. They are
renamed outside the `bbb-mcp-*` prefix (`bbb-backstop-*`), so no wildcard
in either deploy policy can ever match them, and a test asserts that no
deploy statement's resource matches the new names.

Changes from today:

- The action targets both `bbb-mcp-server-exec` and `bbb-mcp-kb-role`.
  Today it names only the server role, and the knowledge base's role also
  calls Bedrock.
- The workload boundary's `bedrock:InvokeModel` narrows from `*` to the
  Titan embedding model and the Haiku inference profile the stack uses,
  so no role under it can call a more expensive model.
- Explicit Denies on both deploy roles cover detaching the backstop
  policy, and every write to it or its role.

### 5.3 Workflow

Jobs in `mcp-deploy.yml`:

1. **build**: no `id-token`, no environment. `npm ci` and `npm run check`
   in `mcp/`, then upload `dist/` as an artifact. Dependency code never
   runs where an AWS token can be minted.
2. **plan**: environment `aws`, update role. Downloads `dist/`,
   `terraform plan -out=tfplan -lock-timeout=5m`, then a unit-tested
   classifier reads `terraform show -json tfplan`:
   - **routine**: only in-place updates the update role can make, plus
     `forget` (the backstop handover): apply here, unattended;
   - **gated**: anything else. Writes an address-and-action summary (no
     values; the plan file holds the anon key and is never uploaded) to
     the job summary and as an output.
3. **apply**: environment `aws`, update role, runs when routine. Applies
   the saved plan, then the smoke test.
4. **apply-gated**: environment `aws-gated`, deploy role, runs only when
   the plan was gated (or the routine apply hit AccessDenied, see 5.5).
   GitHub notifies the maintainer, who approves once. The job re-plans
   with the deploy role and fails unless the set of changed addresses and
   actions matches the summary that was shown, so the approval can't
   cover a different plan. Then apply and smoke test.

Triggers:

- `push` to main, paths `mcp/**`, `infra/**`,
  `analysis/output/cycle_params.json`, `.github/workflows/mcp-deploy.yml`,
  excluding `**/*.md` (doc edits go through `corpus-sync.yml`).
- `workflow_dispatch` with `plan`, `apply` or `destroy`. Plan and apply
  take the same route as a push (re-applying after a repo-variable
  change, which doesn't push). Dispatch only deploys main, so it adds
  nothing a push couldn't. Destroy always goes to `aws-gated`.

Concurrency: all jobs share `group: mcp-deploy`, `cancel-in-progress:
false`, so a burst of merges collapses to "deploy the latest main", and a
gated job awaiting approval holds the slot (the Terraform lock would
serialise them anyway).

### 5.4 Smoke test (accident guard)

After every apply:

- `aws lambda invoke` with a synthetic API Gateway POST to `/mcp`
  carrying `tools/list`: assert the five tool names. Then `get_cycle_model`,
  which is bundled and needs no live data. Not `get_forecast`, whose
  staleness gate would fail deploys on stale data.
- An unauthenticated POST to the public endpoint: expect 403, proving the
  gateway still requires a key. No API key ever enters GitHub.
- Describe the backstop action (`--region us-east-1`): report STANDBY as
  armed. A fired backstop is reported separately and doesn't fail the
  deploy. Anything else ("disarmed") fails it.

### 5.5 Failure handling

- **Notification.** Pushes made through the Claude GitHub App send nobody
  a failure email. So any failed job ends with a step that opens (or
  comments on) an issue labelled `mcp-deploy`, which emails the
  maintainer. The issue is closed by the next successful deploy.
- **AccessDenied on the update role** (a provider bump calling an action
  the role lacks): the failure step names the missing action and the
  CloudShell line that adds it, and queues `apply-gated` so the deploy can
  still go out after one approval. The issue stays open until the role is
  fixed.
- **State lock left by a killed run**: `-lock-timeout=5m` on every
  Terraform command, and a documented `force-unlock` path in the runbook.
- **Knowledge base or data source replaced** (gated, since replacements
  are): the gated runbook includes updating the `MCP_KB_ID` and
  `MCP_DATA_SOURCE_ID` repo variables that `corpus-sync.yml` reads.

### 5.6 Reporting (Dependabot skill)

- `wait-checks.sh` stops counting `mcp-deploy` jobs as checks. A blocked
  plan is not a CI failure.
- A new wait finds the latest `mcp-deploy` run on main since the session
  started (whatever SHA it ran on), ignores runs cancelled as superseded,
  waits up to 40 minutes, and reports one of: deployed, waiting for your
  approval (with the link and the summary), or failed (with the issue).
- At session start, the skill lists open `mcp-deploy` issues.
- The "a shipped `mcp/` fix only reaches the Lambda at the next
  `mcp-deploy` run" guidance goes.

### 5.7 GitHub settings

- `aws`: remove the required reviewer. Deployment branches stay
  "Selected branches", `main` only, with no tag rule.
- `aws-gated`: new, the maintainer as required reviewer, `main` only.
- GitHub Mobile: approvals for pending deployments arrive as a push
  notification, which makes the remaining approval one tap. The build
  checks whether that is already on.
- Branch protection (decision D2): turn on `enforce_admins` and require
  a pull request on main.

## 6. Worst case, with this design

An attacker who controls code on main, running under the update role, can:

- serve wrong or hostile MCP responses, and poison the docs corpus;
- change the Lambda's environment, memory and timeout;
- call Bedrock through the server role, but only the two models the
  boundary allows, and only through requests that reach the Lambda, which
  the API key, the throttle and the monthly quota still gate (the update
  role can't change them).

It cannot create or reshape roles, open a new endpoint, change the API
Gateway, or reach the backstop. Spend therefore stays within the gateway
quota until the backstop fires, plus Budgets' reporting lag of hours. That
is the same order of harm as a bad website deploy: reputational, fixed by
reverting and letting the revert deploy.

Under the deploy role, after the maintainer approves a gated run, the
bound is today's: an approval is still blind, but it is rare and arrives
with a plan summary.

## 7. Tests

- The plan classifier, against recorded plan JSON: routine update, forget,
  allowed replace of `aws_api_gateway_deployment.mcp` (actions
  `["create","delete"]` only), forbidden create, delete and replace.
- `tests/corpus-sync-workflow.test.ts` pins the new workflow shape:
  mcp-deploy's triggers are exactly push and dispatch; the path filter;
  the build job holds no `id-token`; `environment: aws` and `aws-gated`
  appear only in mcp-deploy; every job holding `id-token` declares an
  environment, so a new job can't fall back to the main-ref subject that
  the corpus-sync role trusts.
- `tests/infra-boundaries.test.ts` and its helper model the new role and
  the human-owned backstop: role, policy and boundary counts change, the
  budgets role moves from the Terraform model to the BOOTSTRAP model,
  `trustSubject` handles the roles' new subjects, and new assertions
  cover the update role's allow-list, both roles' backstop Denies, and no
  deploy resource pattern matching `bbb-backstop-*`.
- Tests are not a security control here (section 4); they catch mistakes.

## 8. Docs cascade

The repo describes its own deploy model in many places, and five of the
docs below are in the `ask_docs` corpus, so the live server answers
questions about its deploy model from them. Every change below lands in
the same PR as the build. No follow-up docs PR. The list came from a
full-repo grep during review; the build re-runs that grep before merge.

Corpus docs:

- `infra/BOOTSTRAP.md`:
  - intro ("everything here happens exactly once", "a workflow run you
    have personally approved", "Step 3 is one paste");
  - the OIDC subject comments;
  - 3b trust, policy and rationale (now the gated role);
  - new 3d (backstop) and 3e (update role), appended so existing section
    names and numbers stay stable;
  - Step 4 (two environments, and the "this step is the human-approval
    gate" callout rewritten);
  - the RAG update section ("budget action in the Terraform stack",
    `ALERT_EMAIL`, "destroy still works in the triggered state");
  - key rotation (a key replace is now gated);
  - a new "Update for auto-deploy" migration section;
  - Decommissioning.
- `mcp/README.md`:
  - "terraform destroy removes the entire footprint";
  - the deploys bullet;
  - security posture ("requires a named human reviewer", "can manage the
    budget");
  - cost guards ("a small Terraform-managed monthly budget", "the budget
    action below is the firm layer");
  - key rotation;
  - Decommission.
- `docs/mcp-rag-design.md`: written as a dated design, so it gets a dated
  note pointing here rather than a rewrite of its history. Its "Budget
  action in Terraform" heading and resource list get the note.
- `README.md`: "`budget_limit_usd` in the Terraform stack".
- This document: joins the corpus (decision D3), which needs the manifest
  line plus the matching `corpus-sync.yml` paths entry (a test holds the
  two equal).

Other docs:

- `CLAUDE.md`:
  - MCP subproject section ("deploys ONLY via mcp-deploy, human-approval
    gated", "the one ungated exception", "`terraform destroy` = full
    decommission", "the two permissions boundaries");
  - the wildcard-policy paragraph and its rule "do not carry the pattern
    into anything whose deploys are not approval-gated" (it stays true:
    the wildcards stay on the gated role only);
  - the permanent exit path.
- `PLAN.md`:
  - a new row recording this design as reversing the 2026-08-24
    decision;
  - rows saying changes reach the Lambda "only via an approval-gated
    mcp-deploy run" stay as history.
- `.claude/skills/process-dependabot-prs/SKILL.md`: lines 3, 23, 48, 58
  and 61-63, plus `scripts/wait-checks.sh` and a new wait script.

Code and comments:

- `.github/workflows/mcp-deploy.yml` (rewritten);
- `.github/workflows/corpus-sync.yml` (header contrast, "cannot touch the
  deployed stack", paths for this doc);
- `mcp/scripts/sync-corpus.sh` header;
- `infra/`:
  - `rag.tf` (backstop resources become `removed` blocks; the boundary
    locals and comments);
  - `lambda.tf` (`depends_on` on the deny policy goes; the destroy
    comment);
  - `variables.tf` (`budget_limit_usd`, `budget_alert_email` and its
    validation go);
  - `versions.tf` (the out-of-stack resource list);
  - `outputs.tf` comment;
- the three test files' comments, beyond the assertion changes in
  section 7.

Second-order items:

- **Counts.** "two boundaries" stays two: the human-owned backstop role
  keeps `bbb-mcp-boundary-iam`. "Three roles Terraform creates" becomes
  two. "Two hand-made roles" becomes four.
- **Cross-referenced section names** stay put: "Update for the ungated
  corpus sync", "Decommissioning", 3a, 3c, and the cost-guard layer
  numbers.
- **Exit path (licence cl 4.6).** Push-triggered deploys mean a later
  merge could rebuild a decommissioned stack and serve licensed data
  again. CLAUDE.md's exit path, BOOTSTRAP's Decommissioning and the MCP
  README's Decommission therefore make "delete both deploy roles" a
  required step, along with detaching the backstop policy in CloudShell
  before `destroy` (the new Deny blocks `force_detach_policies` once the
  backstop has fired) and deleting the four backstop resources after.

## 9. Build and migration

The live account must not break at any point. The order is additive,
then forget, then narrow:

1. **PR** with all of the above. CI green; checks run locally first.
2. **Maintainer, CloudShell, before merge** (additive only):
   - create the update role;
   - create the `bbb-backstop-*` resources (a second backstop, armed
     alongside the old one);
   - narrow the workload boundary's model list;
   - add the `aws-gated` subject to the deploy role's trust, keeping
     `aws` for now.
   Each step is idempotent, with existence checks.
3. **Maintainer, GitHub:** create `aws-gated`. Add the
   `AWS_UPDATE_ROLE_ARN` variable.
4. **Merge.** The first run's plan forgets the old backstop resources;
   the classifier treats `forget` as routine, but the old deploy-role
   permissions are still in place, so nothing is denied. The smoke test
   checks the new backstop.
5. **Maintainer, CloudShell:** delete the old backstop resources;
   replace the deploy role's policy with the narrowed one plus the
   Denies; remove the `aws` subject from its trust.
6. **Maintainer, GitHub:** remove the reviewer from `aws`. From here,
   routine merges deploy unattended.
7. **Verify** with a no-op routine deploy (dispatch `apply`), and record
   the dated events in PLAN.md.

Rollback: re-adding the reviewer to `aws` pauses every routine deploy at
once. A full rollback also reverts the trigger change. Never revert the
backstop handover without `import` blocks, or Terraform will try to
create resources that already exist.

## 10. Decisions for the maintainer

- **D1.** The migration needs two CloudShell sessions and two GitHub
  settings visits, one time.
- **D2.** Branch protection: turn on `enforce_admins` and require a pull
  request. Recommended, since push-to-deploy makes main the trust
  boundary. The cost: no direct pushes to main, even by the maintainer.
- **D3.** Should this document join the docs corpus? Recommended yes,
  after the rewrite to post-merge truth. `ask_docs` would then answer
  "how does this deploy?" from it.
- **D4.** Accept that a gated approval is still blind (it shows addresses
  and actions, not code), and rare.

## Doc discipline for this document

During review this is a draft. Before merge it is rewritten as post-merge
truth: decisions recorded as dated events, the build steps as what
happened and what the maintainer ran. Per CLAUDE.md, status lives in
PLAN.md, not here.
