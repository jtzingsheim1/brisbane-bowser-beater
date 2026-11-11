#!/bin/bash
# wait-mcp-deploy.sh <since> [main-sha]
# Reports whether merges to main since <since> (any date git accepts, such as
# 2026-11-11T09:00:00Z) reached AWS through the mcp-deploy workflow. Finds the
# newest first-parent commit on main (default origin/main) since then that
# touches the workflow's push paths, then waits for a deploy of it, printing
# one line and exiting:
#   0 DEPLOYED <sha> <run url>   a successful run on that commit or a later one
#   5 NOTHING_TO_DEPLOY          no merge since <since> touched the paths
#   6 AWAITING_APPROVAL <url>    a run waits on the aws-gated environment, which
#                                also blocks every later run in the group
#   3 FAILED <url>               the newest run for that commit or later failed
#   1 TIMEOUT                    no outcome within MAX_SECONDS
#   2 bad argument, git or GitHub API error (message printed)
# A run cancelled while a newer run exists was superseded by the concurrency
# group and never counts as the outcome. A dispatched run counts unless its
# title names plan or destroy.
#
# API budget: one GitHub call per poll (the workflow's newest runs on main),
# polling every POLL_SECONDS (at least 60), so at most 40 calls over the full
# 40-minute wait. Run git fetch first: the commit search is local.
set -u
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: wait-mcp-deploy.sh <since> [main-sha]"; exit 2; }
SINCE=$1
source "$(dirname "$0")/github-api.sh"
WORKFLOW=mcp-deploy.yml
POLL_SECONDS="${POLL_SECONDS:-60}"; [ "$POLL_SECONDS" -ge 60 ] 2>/dev/null || POLL_SECONDS=60
MAX_SECONDS="${MAX_SECONDS:-2400}"
# Mirrors the push paths of .github/workflows/mcp-deploy.yml.
PATHS=(mcp infra analysis/output/cycle_params.json ".github/workflows/$WORKFLOW" ':(exclude,glob)**/*.md')

top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "wait-mcp-deploy: not in a git checkout"; exit 2; }
cd "$top" || exit 2
MAIN=$(git rev-parse --verify -q "${2:-origin/main}^{commit}") || { echo "wait-mcp-deploy: unknown commit '${2:-origin/main}'"; exit 2; }
TARGET=$(git log -1 --first-parent --format=%H --since="$SINCE" "$MAIN" -- "${PATHS[@]}") \
  || { echo "wait-mcp-deploy: git log failed"; exit 2; }
[ -n "$TARGET" ] || { echo "NOTHING_TO_DEPLOY"; exit 5; }

# is_after SHA: SHA is TARGET or a descendant of it. Fetches main once when a
# run names a commit pushed after the last fetch.
is_after() {
  git cat-file -e "$1^{commit}" 2>/dev/null || git fetch -q origin main 2>/dev/null
  git merge-base --is-ancestor "$TARGET" "$1" 2>/dev/null
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
while [ "$SECONDS" -lt "$MAX_SECONDS" ]; do
  if gh_get "actions/workflows/$WORKFLOW/runs?branch=main&per_page=30"; then
    printf '%s' "$BODY" > "$tmp/runs.json"
    # Newest first: id status conclusion event head_sha url title-flag.
    python3 - "$tmp/runs.json" > "$tmp/runs.tsv" <<'PY'
import json, re, sys
runs = json.load(open(sys.argv[1])).get("workflow_runs", [])
runs.sort(key=lambda r: (r["created_at"], r["id"]), reverse=True)
for r in runs:
    if r["event"] not in ("push", "workflow_dispatch"):
        continue
    other = r["event"] == "workflow_dispatch" and re.search(r"\b(plan|destroy)\b", r.get("display_title") or "", re.I)
    print("\t".join([str(r["id"]), r["status"], r["conclusion"] or "-", r["event"],
                     r["head_sha"], r["html_url"], "skip" if other else "ok"]))
PY
    newest=""; newer_exists=""
    while IFS=$'\t' read -r _ status concl _ sha url flag; do
      # A run waiting for approval holds the concurrency group, whatever it deploys.
      if [ "$status" = waiting ]; then echo "AWAITING_APPROVAL $url"; exit 6; fi
      if [ "$flag" != ok ] || ! is_after "$sha"; then newer_exists=1; continue; fi
      if [ "$status" = completed ] && [ "$concl" = success ]; then echo "DEPLOYED $sha $url"; exit 0; fi
      if [ -z "$newest" ]; then
        # Superseded: cancelled with a newer run behind it. Look further back.
        if [ "$concl" = cancelled ] && [ -n "$newer_exists" ]; then newer_exists=1; continue; fi
        newest="$status $concl $url"
      fi
      newer_exists=1
    done < "$tmp/runs.tsv"
    read -r nstatus nconcl nurl <<<"$newest"
    if [ "${nstatus:-}" = completed ]; then echo "FAILED $nurl ($nconcl)"; exit 3; fi
  fi
  sleep "$POLL_SECONDS"
done
echo "TIMEOUT waiting for a deploy of ${TARGET:0:7} or later (last GitHub API response: HTTP ${LAST_HTTP:-none})"; exit 1
