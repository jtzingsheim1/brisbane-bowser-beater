#!/bin/bash
# wait-checks.sh <pr-number | 40-character commit SHA>
# Blocks until the CI triggered for the target has settled, then prints one
# line and exits: 0 ALL_GREEN, 3 FAIL:<names>, 4 BEHIND or CONFLICT (the PR
# needs updating or rebasing first), 2 bad argument, PR not open or GitHub API
# error (message printed), 1 timed out.
#
# Counts GitHub Actions jobs only from push and pull_request runs, so
# scheduled, manually dispatched and Dependabot-internal runs attached to the
# same commit (common on main) are ignored. Also counts other apps' checks and
# commit statuses, such as Vercel's. Reports only once the PR is not behind main
# and nothing has changed for SETTLE_SECONDS: a follow-on check, such as an
# uploaded code-scanning result, registers a few seconds after the job that
# produced it finishes.
set -u
[ $# -eq 1 ] || { echo "usage: wait-checks.sh <pr-number|commit-sha>"; exit 2; }
TARGET=$1
source "$(dirname "$0")/github-api.sh"
POLL_SECONDS="${POLL_SECONDS:-15}"
SETTLE_SECONDS=45
BEHIND_SECONDS=60       # "update branch" clears behind within seconds; see SKILL.md for rebases
MAX_SECONDS=1200        # several times a normal CI run

if [[ "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then PR=""; SHA=$TARGET
elif [[ "$TARGET" =~ ^[0-9]{1,9}$ ]]; then PR=$TARGET
else echo "wait-checks: expected a PR number or a full 40-character SHA, got '$TARGET'"; exit 2
fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
last_sig=""; settled_since=$SECONDS; behind_since=""; state="n/a"
while [ "$SECONDS" -lt "$MAX_SECONDS" ]; do
  if [ -n "$PR" ]; then
    gh_get "pulls/$PR" || { sleep "$POLL_SECONDS"; continue; }
    read -r pstate merged SHA state < <(python3 -c '
import sys, json
d = json.load(sys.stdin)
print(d["state"], d.get("merged", False), d["head"]["sha"], d.get("mergeable_state") or "unknown")' <<<"$BODY")
    if [ "$pstate" != "open" ]; then
      echo "PR #$PR is not open ($([ "$merged" = True ] && echo merged || echo closed))"; exit 2
    fi
    if [ "$state" = "dirty" ]; then echo "PR #$PR head=$SHA CONFLICT: rebase needed"; exit 4; fi
    if [ "$state" = "behind" ]; then
      behind_since=${behind_since:-$SECONDS}
      [ $((SECONDS - behind_since)) -ge "$BEHIND_SECONDS" ] && { echo "PR #$PR head=$SHA BEHIND: update its branch first"; exit 4; }
      sleep "$POLL_SECONDS"; continue
    fi
    behind_since=""
  fi
  # Filtering by event on GitHub's side keeps these lists short, and clear of
  # the 1000-result cap, even on a main head that cron runs have piled onto.
  gh_get_all "actions/runs?head_sha=$SHA&event=push" workflow_runs "$tmp" runs_push || { sleep "$POLL_SECONDS"; continue; }
  gh_get_all "actions/runs?head_sha=$SHA&event=pull_request" workflow_runs "$tmp" runs_pr || { sleep "$POLL_SECONDS"; continue; }
  gh_get_all "commits/$SHA/check-runs?filter=latest" check_runs "$tmp" || { sleep "$POLL_SECONDS"; continue; }
  gh_get "commits/$SHA/status" || { sleep "$POLL_SECONDS"; continue; }
  printf '%s' "$BODY" > "$tmp/status.json"
  IFS=$'\t' read -r sig done bad summary < <(python3 - "$tmp" <<'PY'
import glob, json, os, sys
d = sys.argv[1]
def pages(prefix, key):
    for f in sorted(glob.glob(os.path.join(d, prefix + "-*.json"))):
        yield from json.load(open(f)).get(key, [])
ci_suites = {r["check_suite_id"] for p in ("runs_push", "runs_pr") for r in pages(p, "workflow_runs")}
items = [(r["name"], r["status"], r["conclusion"] or "") for r in pages("check_runs", "check_runs")
         if r["app"]["slug"] != "github-actions" or r["check_suite"]["id"] in ci_suites]
status = json.load(open(os.path.join(d, "status.json")))
if status.get("total_count"):
    items += [(s["context"], "pending" if s["state"] == "pending" else "completed", s["state"])
              for s in status["statuses"]]
items.sort()
done = bool(items) and all(i[1] == "completed" for i in items)
bad = [n for n, _, c in items if c not in ("success", "skipped", "neutral")]
shown = "; ".join("%s=%s" % (n, c or s) for n, s, c in items)
print("\t".join([repr(items), str(int(done)), ",".join(bad) or "-", shown]))
PY
)
  sig="$SHA $sig"
  if [ "$sig" != "$last_sig" ]; then last_sig=$sig; settled_since=$SECONDS; fi
  if [ "$done" = 1 ] && [ $((SECONDS - settled_since)) -ge "$SETTLE_SECONDS" ]; then
    label=$([ -n "$PR" ] && echo "PR #$PR head=$SHA state=$state" || echo "commit $SHA")
    if [ "$bad" = "-" ]; then echo "$label ALL_GREEN|$summary"; exit 0; fi
    echo "$label FAIL:$bad|$summary"; exit 3
  fi
  sleep "$POLL_SECONDS"
done
echo "timed out after ${MAX_SECONDS}s on ${PR:+PR #$PR }${SHA:-?} (last GitHub API response: HTTP ${LAST_HTTP:-none})"; exit 1
