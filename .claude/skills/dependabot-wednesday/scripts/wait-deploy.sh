#!/bin/bash
# Block until every GitHub deployment recorded for a commit (Vercel reports
# Production deploys of main this way) reaches a final state, then print
# one line: "deploy sha=<short> Production=success".
# "inactive" also counts as final: it is GitHub's state for a deployment
# superseded under auto-inactivation. This repo's superseded deploys have
# kept "success", so it is only a guard.
# Usage: wait-deploy.sh <full commit sha>
set -u
SHA="${1:?usage: wait-deploy.sh <full commit sha>}"
REPO="${REPO:-jtzingsheim1/brisbane-bowser-beater}"
API="https://api.github.com/repos/$REPO"
for _ in $(seq 1 40); do
  ids=$(curl -sS "$API/deployments?sha=$SHA" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(' '.join(f\"{x['id']}:{x.get('environment')}\" for x in d) if isinstance(d,list) else '')" 2>/dev/null)
  if [ -n "$ids" ]; then
    final=1; summary=""
    for pair in $ids; do
      st=$(curl -sS "$API/deployments/${pair%%:*}/statuses" 2>/dev/null | python3 -c "
import sys,json; s=json.load(sys.stdin); print(s[0]['state'] if s else 'pending')" 2>/dev/null)
      summary="$summary ${pair#*:}=${st:-pending}"
      case "$st" in success|inactive|failure|error) ;; *) final=0;; esac
    done
    [ "$final" = 1 ] && { echo "deploy sha=${SHA:0:7}:$summary"; exit 0; }
  fi
  sleep 20
done
echo "deploy sha=${SHA:0:7} TIMED OUT"; exit 1
