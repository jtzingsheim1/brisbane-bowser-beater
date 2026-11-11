#!/usr/bin/env bash
# Post-deploy smoke test for the MCP stack, run by
# .github/workflows/mcp-deploy.yml after every apply (and on a no-change
# run). An accident guard, not a security control: see
# docs/mcp-auto-deploy-design.md sections 4 and 5.4.
#
# It checks health, not tool output: no API key enters GitHub, and the
# unattended update role holds no lambda:InvokeFunction. Tool behaviour is
# covered before merge by the mcp/ unit tests.
#
#   1. GetFunction on bbb-mcp-server: State Active, LastUpdateStatus
#      Successful, and CodeSha256 equal to the base64 SHA-256 of the zip
#      Terraform built from this run's bundle (archive_file in
#      infra/lambda.tf writes it to infra/.terraform/bbb-mcp-server.zip
#      during plan).
#   2. An unauthenticated POST to the `mcp_endpoint` output returns 403,
#      so the gateway still requires an API key.
#   3. The human-owned backstop's budget action (budget
#      bbb-backstop-monthly, us-east-1, infra/BOOTSTRAP.md section 3d).
#      Budgets action statuses, per the AWS Budgets API:
#        STANDBY                       armed, not fired: pass
#        EXECUTION_IN_PROGRESS,
#        EXECUTION_SUCCESS             fired, the deny is applied: pass
#                                      with a warning annotation, and
#                                      backstop=fired in $GITHUB_OUTPUT so
#                                      the workflow skips the corpus sync
#        PENDING, EXECUTION_FAILURE,
#        REVERSE_IN_PROGRESS,
#        REVERSE_SUCCESS,
#        REVERSE_FAILURE,
#        RESET_IN_PROGRESS,
#        RESET_FAILURE, or no action   fail: the backstop is not armed, or
#                                      is mid-transition, and needs a human
#                                      (BOOTSTRAP "If the backstop ever
#                                      fires")
#
# Needs AWS credentials (either deploy role), terraform on PATH and an
# initialised infra/ directory. Works from any CWD.
set -euo pipefail

FUNCTION_NAME=bbb-mcp-server
BUDGET_NAME=bbb-backstop-monthly
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INFRA="$REPO_ROOT/infra"
ZIP="$INFRA/.terraform/bbb-mcp-server.zip"

fail() {
  echo "::error::smoke: $*"
  exit 1
}

# --- 1. The function runs the code just deployed ---------------------------
[ -f "$ZIP" ] || fail "no deployment package at $ZIP (did terraform plan run?)"
expected_sha=$(openssl dgst -sha256 -binary "$ZIP" | base64)

# Terraform waits for the code update to finish, but allow a short settle in
# case the state is read mid-transition.
for attempt in $(seq 1 12); do
  info=$(aws lambda get-function \
    --function-name "$FUNCTION_NAME" \
    --query '[Configuration.State, Configuration.LastUpdateStatus, Configuration.CodeSha256]' \
    --output text)
  read -r state update_status code_sha <<< "$info"
  if [ "$state" = "Active" ] && [ "$update_status" = "Successful" ]; then
    break
  fi
  if [ "$attempt" -eq 12 ] || { [ "$state" != "Pending" ] && [ "$update_status" != "InProgress" ]; }; then
    fail "$FUNCTION_NAME is State=$state LastUpdateStatus=$update_status"
  fi
  echo "smoke: $FUNCTION_NAME is State=$state LastUpdateStatus=$update_status; waiting"
  sleep 10
done
[ "$code_sha" = "$expected_sha" ] ||
  fail "$FUNCTION_NAME CodeSha256 $code_sha does not match the built package $expected_sha"
echo "smoke: $FUNCTION_NAME Active, Successful, CodeSha256 $code_sha"

# --- 2. The gateway still demands an API key -------------------------------
endpoint=$(terraform -chdir="$INFRA" output -raw mcp_endpoint)
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'content-type: application/json' --data '{}' "$endpoint")
[ "$code" = "403" ] ||
  fail "unauthenticated POST to the MCP endpoint returned $code, expected 403"
echo "smoke: unauthenticated POST returned 403"

# --- 3. The cost backstop is armed (or has fired) ---------------------------
account_id=$(aws sts get-caller-identity --query Account --output text)
statuses=$(aws budgets describe-budget-actions-for-budget \
  --account-id "$account_id" \
  --budget-name "$BUDGET_NAME" \
  --region us-east-1 \
  --query 'Actions[].Status' --output text)
[ -n "$statuses" ] && [ "$statuses" != "None" ] ||
  fail "budget $BUDGET_NAME has no actions; the backstop is missing"

fired=false
for status in $statuses; do
  case "$status" in
    STANDBY) ;;
    EXECUTION_IN_PROGRESS|EXECUTION_SUCCESS)
      fired=true
      echo "::warning::smoke: the cost backstop has fired (budget action $status). Its deny blocks the update role's Terraform state writes, so unattended deploys route to the gated path (one approval) until it is reset; the corpus sync is skipped. See infra/BOOTSTRAP.md, 'If the backstop ever fires'." ;;
    *)
      fail "budget action on $BUDGET_NAME is $status; expected STANDBY (see infra/BOOTSTRAP.md)" ;;
  esac
done
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  if [ "$fired" = true ]; then
    echo "backstop=fired" >> "$GITHUB_OUTPUT"
  else
    echo "backstop=armed" >> "$GITHUB_OUTPUT"
  fi
fi
echo "smoke: backstop action status: $statuses"
echo "smoke: passed"
