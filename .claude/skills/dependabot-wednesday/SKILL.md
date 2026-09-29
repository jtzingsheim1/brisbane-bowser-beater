---
name: dependabot-wednesday
description: The weekly Dependabot review-and-merge drill for this repo ("Dependabot Wednesday"). Use when asked to review, merge or action open Dependabot PRs, run the weekly dependency drill, or when out-of-band Dependabot security PRs appear.
---

# Dependabot Wednesday

Justin's standing request: review every open PR, merge the ones you are
confident in, and bring anything else to him **with a recommendation**.
Monitor each step (CI, main, deploy) until it lands. Keep the final report
short: a table of what merged, then only the decisions he needs to make.

## Timing and shape

- The weekly scheduled run lands around 22:00 UTC Tuesday (Wednesday
  morning in Brisbane): grouped `minor-and-patch` PRs for `/` and `/mcp`,
  an `actions` group, Terraform providers in `/infra`, and majors as
  separate PRs (see `.github/dependabot.yml`).
- Single-package PRs for transitive dependencies at other times are
  **security updates**. Map each one to its advisory with
  `npm audit --package-lock-only` on main, in both `/` and `/mcp`.

## Setup

1. `git fetch origin main --prune`, then reset the session's designated
   branch onto `origin/main`. The prune matters: a stale remote-tracking
   ref for an already-merged feature branch makes the stop hook report
   phantom "unpushed commits".
2. List the open PRs and their CI in one pass. The GitHub REST API for this
   repo is reachable with curl through the session proxy, e.g.
   `https://api.github.com/repos/jtzingsheim1/brisbane-bowser-beater/pulls`.

## Reviewing each PR

- **npm groups:** compare `package.json` at `refs/pull/N/head` with main
  rather than reading the whole lockfile diff. Watch for exact-pinned
  packages (`next`, `react`, `react-dom`, `eslint-config-next`), and check
  that `next` and `eslint-config-next` move together.
- **Security PRs:** usually +3/-3 in one lockfile (version, resolved,
  integrity). Classify the package as runtime or dev from the lockfile's
  `dev` flag. For `/mcp`, check whether the package actually ends up in the
  Lambda bundle: run `npm ci && npm run build` in `mcp/` and grep
  `dist/index.mjs` for `node_modules/<pkg>/`. Validate the grep against a
  package known to be bundled (`zod`) before trusting a zero.
- **Terraform:** lock-file only, and within the constraint in `infra/`.
  Provider bumps take effect only on the next human-approved
  `mcp-deploy` run.
- **Actions:** SHA-pinned with a version comment, and updated in lockstep
  across every workflow that uses the action. `configure-aws-credentials`
  is only exercised by `mcp-deploy.yml` and `corpus-sync.yml`, not by PR CI.
- **Stale titles:** Dependabot sometimes refreshes a branch to a newer
  release without retitling it. If the diff's version differs from the
  title, pass a corrected `commit_title` when merging.
- **Peer-pinned pairs:** `vitest` and `@vitest/coverage-v8` pin each other
  exactly. When they arrive as separate majors, neither can merge alone
  (`ERESOLVE` at `npm ci`), so supersede both with one paired PR, as #129
  did. PR CI never runs `--coverage`, so check a coverage run locally.

## Merging

- Squash merges only (linear history), always with `expectedHeadSha`.
- Merge serially. After each merge, update the next PR's branch, wait for
  its CI, then merge. GitHub's "update branch" is safe when the PRs touch
  different files, or disjoint leaf entries in the same lockfile, because
  CI's `npm ci` fails loudly on any lockfile inconsistency. If manifests
  or overlapping ranges are involved, comment `@dependabot rebase` instead,
  so Dependabot regenerates the lockfile.
- Never foreground-sleep. Run `scripts/wait-checks.sh <pr>` and
  `scripts/wait-deploy.sh <sha>` in the background and act on the
  completion notification.

## After the last merge

- Wait for main's CI and the Vercel production deployment
  (`scripts/wait-deploy.sh <main sha>`), and re-run `npm audit` if the
  batch contained security PRs.
- `*.vercel.app` is blocked by the cloud egress proxy, so the live site
  cannot be checked from a cloud session. There are no component tests,
  so when `react`, `next` or UI-affecting packages change, ask Justin to
  eyeball the site.

## Standing decisions

- **ESLint 10 is blocked upstream.** Majors from 10.10.0 on crash at lint
  inside `eslint-plugin-react` (`context.getFilename()` was removed in
  ESLint 10), which `eslint-config-next` pulls in. The fix is
  jsx-eslint/eslint-plugin-react#4022; Justin is subscribed to it. Do not
  re-trace the crash. Each week, check npm for an `eslint-plugin-react`
  release whose eslint peer range includes `^10`.
  - Decided 2026-09-22: leave the eslint-major PR open rather than closing
    it, so Dependabot keeps it current and it goes green on its own once
    the blocker clears.
  - If a fixed plugin is released but the PR is still red, the lockfile is
    probably still pinning the old plugin (`eslint-config-next` asks only
    for `^7.37.0`). Supersede it with a PR that regenerates the lockfile.
  - Decided 2026-09-22: no Dependabot `ignore` rule for eslint majors.
    Justin wants the update to reach him when upstream ships.

## House rules for anything you write

- PR bodies follow `.github/pull_request_template.md`, carry no
  claude.ai/code session links (Justin's preference), and never name a
  model. A dependency bump needs no `PLAN.md` update.
- The language discipline in CLAUDE.md applies to every commit message and
  PR body.
