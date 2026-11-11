# MCP auto-deploy: design and build plan

Status: DRAFT for review (2026-11-11). Not yet built. Before merge this
document is rewritten as post-merge truth (see "Doc discipline for this
document" at the end).

## 1. Problem

Every change to the MCP stack (`mcp/`, `infra/`) reaches AWS only through
`.github/workflows/mcp-deploy.yml`, which takes two manual steps: the
maintainer dispatches it, then the run pauses on the `aws` GitHub
environment's required-reviewer rule until the maintainer approves it, an
approval buried several clicks deep in the Actions UI.

The project is in caretaker mode: the work is the weekly Dependabot batch
plus the odd security alert, run by a Claude session the maintainer starts
and skims. Measured from `git log` (2026-08-01 to 2026-11-11): 44 of 72
commits on main touched `mcp/` or `infra/`, 33 of them Dependabot, and every
weekly batch since late August included at least one MCP or Terraform bump.
So the stack changes every week, and the gate costs two manual steps every
week, for an approval that reviews nothing: the maintainer approves without
reading a diff, and is not expected to.

A second, quieter cost: deploys lag main. Merged MCP changes sit undeployed
until someone remembers to run the workflow (the 2026-11-04 batch is an
example). `analysis/output/cycle_params.json` is bundled into the Lambda at
build time (`mcp/src/cycle-model.ts`), so a quarterly re-fit leaves
`get_cycle_model` serving the old fit until a manual deploy.

## 2. What we already did (precedent)

PR #108 (2026-08-24) made docs-corpus publishing automatic:
`.github/workflows/corpus-sync.yml` runs on any push to main touching a
corpus doc, with no approval, under a separate role (`bbb-mcp-corpus-sync`)
that can only write the corpus bucket and start ingestion. The reasoning
recorded then: "the merge was the editorial decision; a second approval
would re-review nothing", and what makes ungated acceptable is how little
the role can do. This design applies the same reasoning to code and infra
deploys, which means shrinking what an ungated deploy can do until the same
argument holds.

## 3. Goals and non-goals

Goals:

- A merge to main that changes the MCP stack deploys it, with no step from
  the maintainer.
- The weekly Dependabot report confirms the AWS deploy, the same way it
  already confirms the Vercel deploy, so "nothing needed from me" covers AWS.
- Anything that genuinely needs the maintainer (destroying the stack, a
  plan that deletes or replaces resources, an IAM change that only a human
  may make) stops and says so clearly, and the stop is as frictionless as
  possible.
- The worst case of an unattended deploy is bounded, and the bound is
  stated.

Non-goals:

- No autonomous loop. The maintainer still starts every Claude session;
  nothing here wakes Claude up.
- No change to the website's deploy path (Vercel on push to main).
- No change to the corpus-sync design beyond what the new workflow forces.

## 4. Threat model: what the approval gate actually protects

The `bbb-mcp-deploy` role trusts any GitHub Actions job whose OIDC subject
is `repo:...:environment:aws`. The `aws` environment allows only `main`
(deployment branch rule) and requires the maintainer's approval. So today
AWS credentials need both:

1. code on main (the branch rule), and
2. a human click (the reviewer rule).

Dropping (2) leaves (1). Who can put code on main:

- The maintainer, merging PRs.
- Claude sessions, merging Dependabot PRs and PRs the maintainer asked
  for, through the Claude GitHub App. (Per Anthropic's documented app
  permissions the app has Actions read only, so it can merge but likely
  cannot dispatch workflows. To verify in the build, not assumed.)
- Anything with write access to the repo: a leaked token, a compromised
  dependency's install script running in a privileged context, a future
  collaborator.

The website already runs on (1) alone: Vercel deploys main to production
automatically, and Vercel holds the more sensitive secrets (Supabase
service-role key, Anthropic key, Stripe secret). So "code on main goes
live" is already the project's trust model. The AWS gate is the exception,
not the rule. It was justified (CLAUDE.md, BOOTSTRAP.md section 3b) because
the deploy role is "account-powerful by construction", so a human click was
the real control. This design removes the click by removing that
justification: it narrows what the role can do until an ungated deploy is
no worse than an ungated Vercel deploy.

What the click does NOT protect against, today: a malicious change that
lands on main gets approved like any other, because approvals are blind.
So the click's real value is narrow: it stops a token that can dispatch
workflows but not land code on main. Branch protection (required `check`)
already limits landing code on main to PRs that pass CI.

## 5. Worst case of an ungated deploy, and how to bound it

Assume an attacker controls what a deploy runs (malicious code on main).
What can the deploy role do, after the boundaries landed in PR #103?

| Capability | Today | Worst case | Bound after this design |
| :- | :- | :- | :- |
| Create/modify stack roles | Capped by the two permissions boundaries; can't touch its own role or the boundaries | Server role gets Bedrock invoke on any model | Unchanged: cost, bounded by the backstop below |
| Lambda (`lambda:*` on `bbb-mcp-*`) | Full control of the function | Serve wrong or hostile responses from the MCP endpoint | Same class as a bad Vercel deploy: reputational, fixed by revert + redeploy |
| API Gateway (`apigateway:*`, region) | Full control | Remove the API key requirement or quota, opening `ask_docs` to the world | Cost, bounded by the backstop |
| Budgets (`budgets:*` on `bbb-mcp-*`) | Full control | Delete the budget action, then run up Bedrock spend unbounded | **The gap. Closed by moving the backstop out of the deploy role's reach (section 6.2)** |
| Detach the Bedrock deny after it fires | `iam:DetachRolePolicy` on server roles | Re-enable spend after the backstop fired | **Closed by an explicit Deny (section 6.2)** |
| Corpus bucket, vectors, KB | Full control on `bbb-mcp-*` | Poison `search_docs`/`ask_docs` answers | Same class as Lambda: reputational |
| Terraform state | Read/write | Corrupt state, forcing a manual repair | Operational nuisance only |
| Anything outside `bbb-mcp-*` | No | n/a | The account holds nothing else |

So once the cost backstop is out of reach, the worst case is: the MCP
endpoint misbehaves, and spend runs up to the backstop's limit
(`budget_limit_usd`, plus Budgets' reporting lag of hours) before Bedrock
is cut off. That is the bound this design commits to, and it is the same
order of harm as a bad website deploy.

## 6. Design

### 6.1 Workflow

`mcp-deploy.yml` becomes:

- **Triggers:**
  - `push` to main with paths `mcp/**`, `infra/**`,
    `analysis/output/cycle_params.json`, `.github/workflows/mcp-deploy.yml`
    (and the shared corpus script if it moves).
  - `workflow_dispatch` with `plan` / `apply`, for re-applying after a
    repo-variable change (variables don't trigger a push).
- **Environment:** `aws`, now with NO required reviewer but still limited
  to `main`. The OIDC subject is unchanged, so the trust policy needs no
  change for apply.
- **Plan safety check (new):** `terraform plan -out=tfplan`, then
  `terraform show -json tfplan` checked by a small script:
  - Updates and creates apply unattended.
  - Any `delete` or `replace` of a resource fails the run with a clear
    message, EXCEPT an allow-list of resources that are replaced by design
    (`aws_api_gateway_deployment.mcp`, which uses `create_before_destroy`
    and is replaced whenever the API surface changes).
  - A blocked plan is applied through the gated path (6.3). The check is a
    unit-tested script, not inline shell.
- **Apply the saved plan** (`terraform apply tfplan`), so what was checked
  is exactly what runs.
- **Post-deploy smoke test (new):** invoke the Lambda directly
  (`aws lambda invoke`) with an MCP `tools/list` request and assert the
  five tool names, plus a `get_cycle_model` call. This uses the deploy
  role (already has `lambda:InvokeFunction` on the function) and needs no
  API key, so no key ever reaches GitHub. Also assert the budget action
  reads `STANDBY`, so a disarmed backstop fails the deploy loudly.
- **Concurrency:** keep `group: mcp-deploy`, `cancel-in-progress: false`.
  GitHub keeps one running and one pending run per group, so a burst of
  merges collapses to "deploy the latest main".
- **Corpus sync after apply:** unchanged. Check for a conflict when a
  single push triggers both this and `corpus-sync.yml` (two
  `StartIngestionJob` calls on one data source); see open question Q5.

### 6.2 IAM changes (maintainer, CloudShell)

1. **Move the cost backstop out of Terraform.** The budget, the budget
   action, the `bbb-mcp-bedrock-deny` policy and the `bbb-mcp-budgets-action`
   role move to BOOTSTRAP.md, created once by a human, like the
   permissions boundaries. Terraform forgets them with `removed` blocks
   (`lifecycle { destroy = false }`), so nothing is deleted in the
   handover. The server role's name stays stable so the human-created
   action keeps targeting it.
2. **Narrow the deploy policy:**
   - `budgets:*` replaced by read-only `budgets:ViewBudget` /
     `budgets:DescribeBudgetAction*` on `bbb-mcp-*`, enough for the smoke
     test's STANDBY check and nothing more (the deploy no longer manages
     budgets).
   - Explicit Deny on `iam:DetachRolePolicy` where `iam:PolicyARN` is the
     bedrock-deny policy, and on any write to that policy.
   - The `bbb-mcp-budgets-*` IAM statements removed with the role.
   - Wildcard service actions (`lambda:*`, `s3:*` on the corpus bucket,
     `s3vectors:*`, `apigateway:*`) narrowed. See open question Q1 for how
     far.
3. **Destroy environment:** a second environment, `aws-gated`, with the
   maintainer as required reviewer, limited to main. The deploy role's
   trust policy gains its subject (`...:environment:aws-gated`). Used for
   `destroy` and for applying a plan the safety check blocked.

`tests/infra-boundaries.test.ts` and `tests/helpers/infra-policies.ts`
model the new policy documents exactly as they do today.

### 6.3 The remaining human step, made frictionless

Only two things stay gated: `destroy` (rare, irreversible) and a plan the
safety check blocked (rare: no such plan has occurred in the stack's
history, to verify in the build). For those:

- The blocked run's failure message gives the exact next step, with a
  direct link to dispatch the gated run.
- The Dependabot skill reports a blocked plan as a decision needed, with
  the link and a plain-English summary of what the plan deletes.
- GitHub Mobile can approve pending deployments from a push notification.
  The build checks whether that's already on and, if not, says how to
  turn it on.

### 6.4 Reporting (Dependabot skill)

The Verify step already waits for checks and the Vercel deploy on the final
main SHA. It gains: wait for the `mcp-deploy` run on that SHA (or confirm
none was triggered), and report success, failure, or a blocked plan. The
"a shipped `mcp/` fix only reaches the Lambda at the next `mcp-deploy` run"
guidance goes away.

## 7. Testing

More unit tests don't make an unattended deploy safer. These do:

- The plan safety check, unit-tested against recorded plan JSON (update,
  allowed replace, forbidden delete, forbidden replace).
- The post-deploy smoke test, run on every deploy.
- Guard tests updated deliberately: `tests/corpus-sync-workflow.test.ts`
  currently asserts mcp-deploy's triggers are exactly `workflow_dispatch`
  and that only "the human-dispatched, environment-gated deploy workflow"
  may request an AWS token; `tests/infra-boundaries.test.ts` pins every
  role's grants. Both are rewritten to pin the NEW shape (push + dispatch
  triggers, path filter, the two environments, which jobs may use which),
  not loosened.
- A new guard: the backstop resources must not appear in `infra/*.tf`
  (only in `removed` blocks) and the deploy policy must carry the backstop
  Denies.

## 8. Docs cascade

The repo describes itself in its own docs, and four of the docs below are
in the `ask_docs` corpus, so the server answers questions about its own
deploy model from them. All of these change in the same PR as the build.
No follow-up docs PR.

| File | In corpus | What changes |
| :- | :- | :- |
| `CLAUDE.md` | no | MCP subproject section: "deploys ONLY via mcp-deploy (human-approval gated)" and the wildcard-justification paragraph rewritten to the new model; exit path wording for destroy |
| `PLAN.md` | no | New status row, written as post-merge truth |
| `infra/BOOTSTRAP.md` | yes | Section 3b trust/policy and its rationale comments; new backstop section; Step 4 environment setup (two environments); the "this step is the human-approval gate" callout; an "Update for auto-deploy" migration section for the live account, like the existing corpus-sync one; Decommissioning |
| `mcp/README.md` | yes | Deploys bullet, security posture (the "requires a named human reviewer" passage), cost-guard layer 4 description, Decommission |
| `docs/mcp-rag-design.md` | yes | Corpus sync paragraph, cost backstop resource list (now bootstrap-owned), deploy-role delta, human-at-keyboard steps |
| `README.md` | yes | Probably none ("deployed exclusively via GitHub Actions OIDC" stays true); confirm |
| `docs/deploy-runbook.md` | yes | Check for MCP deploy steps; currently no gate mentions |
| `.claude/skills/process-dependabot-prs/SKILL.md` | no | Verify step gains the MCP deploy wait; two "next mcp-deploy run" lines go |
| `.github/workflows/corpus-sync.yml` | n/a | Header comment contrasts itself with the gated deploy |
| `.github/workflows/mcp-deploy.yml` | n/a | Header security-model comment |
| `infra/rag.tf`, `infra/outputs.tf` | n/a | Backstop comments and resources; outputs comment |
| `tests/*` (three files) | n/a | Comments describing the gate, plus the assertions above |
| `docs/mcp-auto-deploy-design.md` | decide (Q6) | This document |

The reviewers check this table against a full-repo grep, not against this
list.

## 9. Build plan

One PR. Order matters because the live account must not break between
merge and the maintainer's CloudShell steps:

1. **Code + docs PR** (everything above). The new workflow tolerates the
   old account state where it can and fails closed otherwise:
   - If `aws-gated` doesn't exist yet, only destroy and blocked plans are
     affected.
   - The `removed` blocks make Terraform forget the backstop without
     deleting it.
2. **Maintainer, before merge:** CloudShell paste from the new BOOTSTRAP
   "Update for auto-deploy" section (adopts the backstop as human-owned,
   new deploy policy, trust policy with the second subject). Then GitHub
   settings: create `aws-gated` with reviewer + main; remove the reviewer
   from `aws`.
3. **Merge.** The push triggers the first unattended deploy, which is
   also the end-to-end test: Terraform forgets the backstop (no deletes),
   smoke test passes, budget action reads STANDBY.
4. **Record** the event in PLAN.md as a dated line (in the PR itself, as
   post-merge truth, with the verification recorded as a follow-up line
   only if something differs).

Rollback: re-add the reviewer to `aws` (one setting) restores today's
behaviour immediately, without a code change.

## 10. Open questions

- **Q1. How far to narrow the wildcard service actions.** Strict
  least-privilege (enumerate the exact actions Terraform uses, from
  CloudTrail or IAM last-accessed data) is the tightest, but an AWS
  provider bump can then need a new action, failing the unattended deploy
  until the maintainer adds it in CloudShell: a recurring caretaker-mode
  chore. The alternative keeps resource-scoped wildcards where the
  resource scope already does the work (`lambda:*` on `bbb-mcp-*`) and
  spends the effort on Denies for the things that matter (the backstop).
  Draft recommendation: the hybrid, because section 5's bound comes from
  the backstop, not from the wildcards.
- **Q2.** Is `aws-gated` the right name, and should a blocked plan use it
  or require CloudShell?
- **Q3.** Smoke test via direct Lambda invoke vs through API Gateway
  (needs a key in GitHub; rejected so far).
- **Q4.** Should the deploy also run `plan` on PRs touching `infra/`? That
  needs AWS credentials in PR context, which this design avoids. Draft
  answer: no; `terraform validate` in CI stays the PR-time check.
- **Q5.** Corpus ingestion conflict when one push triggers both
  workflows: confirm `sync-corpus.sh` handles a running job, or drop the
  apply-time sync now that every doc change syncs on its own.
- **Q6.** Does this document join the corpus? Draft answer: yes, it
  explains the deploy model, which `ask_docs` should be able to answer.

## Doc discipline for this document

During review this is a draft. Before merge it is rewritten as post-merge
truth: decisions as dated events, open questions resolved or removed, and
the build plan reduced to what happened and what the maintainer ran. Per
CLAUDE.md, status lives in PLAN.md, not here.
