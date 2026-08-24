#!/usr/bin/env bash
# Syncs the curated docs corpus to the corpus bucket and runs a Bedrock
# ingestion job to completion. Shared by both workflows that publish the
# corpus (.github/workflows/corpus-sync.yml on doc merges, and the gated
# .github/workflows/mcp-deploy.yml after each apply), so the staging
# validation and ingestion handling cannot drift between them.
#
# Required environment: KB_ID, DS_ID, CORPUS_BUCKET.
# Works from any CWD; paths resolve relative to the repo root.
set -euo pipefail

: "${KB_ID:?KB_ID is required}"
: "${DS_ID:?DS_ID is required}"
: "${CORPUS_BUCKET:?CORPUS_BUCKET is required}"

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MANIFEST="$REPO_ROOT/mcp/corpus-manifest.txt"

# Entries are validated inline (not only by the unit test in mcp/):
# repo-relative markdown paths with a conservative character set, no
# traversal, no absolute paths.
STAGE=$(mktemp -d)
# `|| [ -n "$entry" ]` so a manifest whose final line lost its trailing
# newline still contributes its last entry rather than silently dropping it.
while IFS= read -r entry || [ -n "$entry" ]; do
  case "$entry" in ''|'#'*) continue ;; esac
  case "$entry" in
    /*|*..*|*[!A-Za-z0-9._/-]*)
      echo "Refusing unsafe manifest entry: $entry"; exit 1 ;;
    *.md) ;;
    *)
      echo "Refusing non-markdown manifest entry: $entry"; exit 1 ;;
  esac
  mkdir -p "$STAGE/$(dirname "$entry")"
  cp "$REPO_ROOT/$entry" "$STAGE/$entry"
done < "$MANIFEST"
aws s3 sync "$STAGE" "s3://$CORPUS_BUCKET/" --delete

# Starting can collide with an ingestion job another run already has in
# flight (Bedrock allows one at a time per data source), so retry with a
# pause instead of failing outright; the error is printed each attempt so
# a non-transient failure is still visible in the log.
JOB_ID=""
for _ in $(seq 1 8); do
  if JOB_ID=$(aws bedrock-agent start-ingestion-job \
      --knowledge-base-id "$KB_ID" \
      --data-source-id "$DS_ID" \
      --query 'ingestionJob.ingestionJobId' --output text); then
    break
  fi
  echo "start-ingestion-job failed; retrying in 30s"
  sleep 30
done
if [ -z "$JOB_ID" ]; then
  echo "Could not start an ingestion job"
  exit 1
fi
echo "Started ingestion job $JOB_ID"

for _ in $(seq 1 60); do
  # A transient poll failure (throttle, 5xx) is not an ingestion
  # failure; keep polling and let the loop's timeout decide.
  if ! STATUS=$(aws bedrock-agent get-ingestion-job \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --query 'ingestionJob.status' --output text); then
    echo "Status poll failed; retrying"
    sleep 10
    continue
  fi
  echo "Ingestion status: $STATUS"
  case "$STATUS" in
    COMPLETE)
      exit 0 ;;
    FAILED|STOPPED)
      aws bedrock-agent get-ingestion-job \
        --knowledge-base-id "$KB_ID" \
        --data-source-id "$DS_ID" \
        --ingestion-job-id "$JOB_ID" \
        --query 'ingestionJob.failureReasons' --output text
      exit 1 ;;
  esac
  sleep 10
done
echo "Timed out waiting for ingestion to complete"
exit 1
