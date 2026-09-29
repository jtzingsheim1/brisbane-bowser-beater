#!/bin/bash
# wait-deploy.sh <40-character commit SHA on main>
# Blocks until the commit's production deployment is final, then prints one
# line and exits: 0 deployed, 3 failed, 5 nothing recorded for this commit
# (a skipped build, or a repo that doesn't deploy it), 2 bad argument or
# GitHub API error, 1 timed out.
# Only the DEPLOY_ENV environment counts: other workflows record deployments
# against the same commits. Vercel records the GitHub deployment only once a
# build finishes, so until then progress is read from the commit status it
# posts under DEPLOY_STATUS_CONTEXT.
set -u
[ $# -eq 1 ] || { echo "usage: wait-deploy.sh <commit-sha>"; exit 2; }
SHA=$1
source "$(dirname "$0")/github-api.sh"
DEPLOY_ENV="${DEPLOY_ENV:-Production}"
DEPLOY_STATUS_CONTEXT="${DEPLOY_STATUS_CONTEXT:-Vercel}"
POLL_SECONDS="${POLL_SECONDS:-20}"
NOTHING_SECONDS=80       # a push gets its pending status within seconds
MAX_SECONDS=900          # several times a normal production build

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "wait-deploy: expected a full 40-character SHA, got '$SHA'"; exit 2; }
gh_get "commits/$SHA"   # exits 2, with GitHub's message, if the commit doesn't exist
env_q=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$DEPLOY_ENV")
nothing_since=""
while [ "$SECONDS" -lt "$MAX_SECONDS" ]; do
  if gh_get "deployments?sha=$SHA&environment=$env_q"; then
    dep=$(python3 -c 'import sys, json; d = json.load(sys.stdin); print(d[0]["id"] if d else "")' <<<"$BODY")
    if [ -n "$dep" ] && gh_get "deployments/$dep/statuses"; then
      st=$(python3 -c 'import sys, json; s = json.load(sys.stdin); print(s[0]["state"] if s else "pending")' <<<"$BODY")
      case "$st" in
        success|inactive) echo "deploy ${SHA:0:7}: $DEPLOY_ENV=$st"; exit 0 ;;
        failure|error)    echo "deploy ${SHA:0:7}: $DEPLOY_ENV=$st"; exit 3 ;;
      esac
    elif [ -z "$dep" ] && gh_get "commits/$SHA/status"; then
      st=$(python3 -c '
import sys, json
ctx = sys.argv[1]
s = [x["state"] for x in json.load(sys.stdin).get("statuses", []) if x["context"] == ctx]
print(s[0] if s else "none")' "$DEPLOY_STATUS_CONTEXT" <<<"$BODY")
      case "$st" in
        failure|error) echo "deploy ${SHA:0:7}: $DEPLOY_STATUS_CONTEXT build $st"; exit 3 ;;
        pending) nothing_since="" ;;
        *) nothing_since=${nothing_since:-$SECONDS}
           if [ $((SECONDS - nothing_since)) -ge "$NOTHING_SECONDS" ]; then
             echo "deploy ${SHA:0:7}: no $DEPLOY_ENV deployment recorded ($DEPLOY_STATUS_CONTEXT status: $st)"; exit 5
           fi ;;
      esac
    fi
  fi
  sleep "$POLL_SECONDS"
done
echo "deploy ${SHA:0:7}: timed out after ${MAX_SECONDS}s (last GitHub API response: HTTP ${LAST_HTTP:-none})"; exit 1
