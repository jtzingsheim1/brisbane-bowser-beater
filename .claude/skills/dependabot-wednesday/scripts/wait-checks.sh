#!/bin/bash
# Block until every check run on a PR's current head has completed, then
# print one line: "PR #N head=<full sha> ALL_GREEN|..." or "...FAIL:<names>|...".
# Run it in the background and act on the completion notification.
#
# Guards against the update-branch race: the head must stay the same across
# two consecutive completed polls, and GitHub must no longer report the PR
# as behind main, so an old head's finished checks are never mistaken for
# the updated head's.
#
# Uses the GitHub REST API via curl, which cloud sessions reach through the
# session proxy (unauthenticated elsewhere: 60 requests/hour).
# Meant for use right after updating a PR's branch; on a PR left behind main
# it waits for an update that never comes and times out saying so.
# Usage: wait-checks.sh <pr_number>
set -u
PR="${1:?usage: wait-checks.sh <pr_number>}"
REPO="${REPO:-jtzingsheim1/brisbane-bowser-beater}"
API="https://api.github.com/repos/$REPO"
stable=0; last_sha=""
for _ in $(seq 1 60); do
  meta=$(curl -sS "$API/pulls/$PR" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin); print(d['head']['sha'], d.get('mergeable_state') or 'unknown')" 2>/dev/null)
  sha=${meta%% *}; state=${meta#* }
  if [ -z "$meta" ]; then sleep 15; continue; fi
  [ "$sha" != "$last_sha" ] && stable=0 && last_sha=$sha
  res=$(curl -sS "$API/commits/$sha/check-runs" 2>/dev/null | python3 -c "
import sys,json
r=json.load(sys.stdin).get('check_runs',[])
if len(r)>=4 and all(x['status']=='completed' for x in r):
    bad=[x['name'] for x in r if x['conclusion'] not in ('success','skipped','neutral')]
    print('DONE|'+('FAIL:'+','.join(bad) if bad else 'ALL_GREEN')+'|'+'; '.join(f\"{x['name']}={x['conclusion']}\" for x in r))
else:
    print('PENDING')" 2>/dev/null)
  case "$res|$state" in
    DONE*\|behind|DONE*\|unknown) stable=0;;
    DONE*) stable=$((stable+1));;
    *) stable=0;;
  esac
  if [ "$stable" -ge 2 ]; then
    r=${res#DONE|}; echo "PR #$PR head=$sha ${r%|*}|${r##*|}"; exit 0
  fi
  sleep 15
done
if [ "${state:-}" = "behind" ]; then
  echo "PR #$PR TIMED OUT: still behind main, update its branch first (head=$last_sha)"
else
  echo "PR #$PR TIMED OUT waiting for checks (head=$last_sha, state=${state:-unknown})"
fi
exit 1
