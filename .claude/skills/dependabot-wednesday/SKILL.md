---
name: dependabot-wednesday
description: Reviews this repository's open Dependabot PRs and merges the safe ones one at a time, updating each branch and waiting for CI, then verifies main, the production deploy and npm audit. Use when the user asks to review, merge or action Dependabot PRs, including scheduled batches and out-of-band security updates.
---

# Dependabot review and merge

Merge only when the user has asked for merges (a scheduled run only if its
prompt says to); a review-only request gets a report. Merge what you are
confident in. Leave anything else open (a major, failing CI, a surprise in
the diff) and report it with a recommendation. Keep the report short: what
merged, then only the decisions needed.

Standing decisions about specific dependencies, such as a major that is
blocked upstream, live under "Still parked" in `PLAN.md`: follow them instead
of re-deriving them, and don't update, rebase or re-run CI on a PR parked
there. Record a new maintainer decision there as a dated event.

```
- [ ] Sync with main
- [ ] Triage every open PR
- [ ] Merge the safe ones one at a time, security updates first
- [ ] Verify main, the deploy and npm audit
- [ ] Report
```

## Sync

Run `git fetch --prune origin`. If the working tree has uncommitted or
unpushed work, stop and ask the user. Otherwise run
`git checkout --detach origin/main`, and repeat both steps before Verify.

## Triage

- A PR counts as Dependabot's only if its author is `dependabot[bot]`, its
  branch lives in this repository, and every commit on it is by
  `dependabot[bot]`, apart from merge commits from main made by "update
  branch". Otherwise report it and leave it alone.
- Groups and schedules are in `.github/dependabot.yml`. A single transitive
  package arriving outside that schedule is usually a security update: map it
  to its advisory with `npm audit --package-lock-only` at the repo root and
  in `mcp/`.
- For a security update, check whether the vulnerable package ships. In the
  app, use the lockfile's `dev` flag. In `mcp/`, run `npm ci && npm run build`,
  then grep `dist/index.mjs` for `node_modules/<pkg>/`; trust a zero only after
  the same grep finds a package known to be bundled, such as `zod`. Shipping
  never blocks a green merge, but it puts the PR first in the report. A shipped
  `mcp/` fix only reaches the Lambda at the next `mcp-deploy` run, so say so.
- For grouped npm PRs, compare `package.json` at `refs/pull/<n>/head` with
  main rather than reading the lockfile diff.
- Some packages move in lockstep: `vitest` with `@vitest/coverage-v8` (which
  pins `vitest` exactly), and `next` with `eslint-config-next`. If Dependabot
  splits a pair, open one PR that bumps both, close Dependabot's PRs with a link
  to it, and merge it under the same rules once green. For the vitest pair,
  also run `npm test -- --coverage` locally, since PR CI never runs coverage.
- Terraform bumps must be lockfile-only and within the constraints in
  `infra/`. They take effect at the next approval-gated `mcp-deploy` run.
- Actions: every `uses:` keeps its pinning style. SHA pins keep a full SHA
  with a `# vX.Y.Z` comment, identical across workflows. PR CI never runs
  `configure-aws-credentials`; a bump to it first runs in `corpus-sync`
  (unattended, on the next corpus-doc push to main) or `mcp-deploy`, so name
  that in the report.
- If a PR's diff shows a newer version than its title, merge with a corrected
  commit title.
- For UI-facing bumps (`react`, `next` and similar), check the PR's Vercel
  preview before merging: the chart renders, not the paused or unavailable
  page. If you can't load it, ask the user to check it.

## Merge

For each PR, in turn:

1. Run `${CLAUDE_SKILL_DIR}/scripts/wait-checks.sh <pr>` in the background.
   It prints ALL_GREEN, FAIL, BEHIND or CONFLICT with the head SHA, or
   GitHub's error message.
2. ALL_GREEN: squash-merge pinned to that `head=` SHA (`expectedHeadSha` with
   the GitHub MCP merge tool, `--match-head-commit` with `gh pr merge`).
   FAIL: leave it open and report it. BEHIND: update the branch and rerun.
   CONFLICT: comment `@dependabot rebase`, then wait as in step 3 and rerun.
3. Bring the next PR up to date. If the merge you just made touched the same
   lockfile, comment `@dependabot rebase` so Dependabot regenerates it;
   otherwise use GitHub's "update branch". A Dependabot rebase is
   asynchronous: wait for the PR's head SHA to change before rerunning
   `wait-checks.sh`, and if it hasn't changed within about 10 minutes, leave
   the PR open and report it. If Dependabot refuses because the branch was
   edited, comment `@dependabot recreate`.

## Verify

If anything merged: with main checked out fresh (see Sync), run
`wait-checks.sh` and `${CLAUDE_SKILL_DIR}/scripts/wait-deploy.sh` on
`$(git rev-parse origin/main)`, then `npm audit --package-lock-only` at the
repo root and in `mcp/`.

Both scripts take the repository from the `origin` remote (override with
`REPO=owner/name`) and send `GH_TOKEN` or `GITHUB_TOKEN` when set. Anonymous
GitHub API calls are limited to 60 an hour.
