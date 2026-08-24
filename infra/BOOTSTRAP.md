# AWS bootstrap runbook (one-time, ~30-45 minutes)

This is the one-time, human-in-the-loop setup for the BBB MCP server's AWS
account. Everything here happens exactly once. After this sitting, every
deploy runs through GitHub Actions with short-lived OIDC credentials, and
nothing else ever needs the AWS console.

What you end up with:

- A fresh AWS account with MFA on the root user and **zero long-lived access
  keys**. No IAM users exist at all. The only programmatic access to the
  account is two roles GitHub Actions assumes via OIDC: a deploy role that
  can only be assumed by a workflow run you have personally approved, and a
  narrow corpus-sync role (bucket writes plus ingestion only) that jobs
  running on main can assume without a gate.
- An S3 bucket for Terraform state (versioned, encrypted, public access
  blocked).
- A zero-spend budget that emails you if the account ever accrues charges.
- Two customer-managed permissions-boundary policies
  (`bbb-mcp-boundary-workload`, `bbb-mcp-boundary-iam`) that cap what the
  roles Terraform creates can ever hold. The deploy role cannot create,
  edit, remove or swap them, which is what makes them a real ceiling
  rather than a default.
- A GitHub environment named `aws` with you as required reviewer, plus the
  repository variables the two workflows read.

Steps 1 and 2 are console clicking. Step 3 is one paste into CloudShell.
Step 4 is GitHub settings. Have your password manager, phone, and a
credit/debit card ready.

---

## Step 1 -- Create the AWS account (~15 min)

1. Go to <https://signup.aws.amazon.com> and choose **Create a new AWS
   account**.
2. Use an email you control long-term. Pick a strong password and save both
   in your password manager immediately. This is the **root user**.
3. Account type: **Personal**. Fill in address details.
4. Add the payment card. AWS may place a small temporary verification hold.
   Nothing in this project should ever charge the card (see the budget in
   Step 3), but a card is mandatory for signup.
5. Complete the phone verification (SMS or voice).
6. Support plan: **Basic (free)**.
7. Sign in to the console as root: <https://console.aws.amazon.com>.

## Step 2 -- Lock down the root user (~5 min)

1. In the console search bar type **IAM** and open it.
2. On the IAM dashboard, under **Security recommendations**, choose **Add
   MFA** for the root user (or: top-right account menu, **Security
   credentials**, **Assign MFA device**).
3. Register your authenticator app (or passkey). Store the recovery
   information in your password manager.
4. Do **not** create access keys for the root user, and do not create any
   IAM users. This account will never have long-lived credentials. That is
   deliberate and is part of the security posture of the project.

## Step 3 -- CloudShell bootstrap (~10 min, one paste)

1. **First, on GitHub: opt the repo into immutable OIDC subject claims.**
   In the repo, go to **Settings, Actions**, and find the **OIDC** settings
   (GitHub shows a toggle for the immutable subject claim format, plus a
   preview of the exact subject your repo will send). Enable it, then
   confirm the previewed subject matches the FRONT PORTION of the
   `GITHUB_SUB` value in the script below (name@numeric-id for both the
   account and the repo). The preview shows only that prefix; the
   `:environment:aws` tail is appended by GitHub at token time because
   the deploy job runs in the `aws` environment, so the preview is not
   expected to include it. This permanently ties the AWS trust policy to
   the repo's numeric IDs, so a recycled account or repo name can never
   mint matching tokens. Treat the toggle as one-way. If the previewed
   prefix differs from the script's in any way, update `GITHUB_SUB` to
   `<previewed-prefix>:environment:aws` before running.
2. In the AWS console's top-right region selector, choose
   **Asia Pacific (Sydney) ap-southeast-2**.
3. Open **CloudShell** (the terminal icon in the top toolbar, or search
   "CloudShell").
4. **Edit the variables at the top** of the script below (your alert
   email; the subject claim is prefilled from this repo's IDs), then paste
   the whole thing into CloudShell and press Enter.

The script is idempotent: if a resource already exists it says so and moves
on, so it is safe to re-run if anything is interrupted.

```bash
# ============================================================
# BBB MCP one-time bootstrap. Region: ap-southeast-2 (Sydney).
# EDIT THESE TWO LINES, then paste the whole script.
# ============================================================
ALERT_EMAIL="you@example.com"   # billing alert email
# The immutable OIDC subject this repo's gated `aws` environment sends
# (Step 3.1). Numeric IDs are the permanent GitHub account and repo IDs.
# The part before ":environment:aws" must exactly match the prefix shown
# by the repo's OIDC settings preview (the tail is added at token time).
GITHUB_SUB="repo:jtzingsheim1@43869157/brisbane-bowser-beater@1245389373:environment:aws"
# ============================================================
# The subject a job running on this repo's main ref sends (no environment
# tail, so no approval gate). Derived from GITHUB_SUB so the two can never
# disagree on the repo. Note this matches by REF, not by event: any job in
# the repo running on main that requests an OIDC token sends this subject,
# not only the corpus-sync workflow's pushes. See section 3c.
CORPUS_SYNC_SUB="${GITHUB_SUB%:environment:aws}:ref:refs/heads/main"

set -u
REGION="ap-southeast-2"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="bbb-mcp-tfstate-${ACCOUNT_ID}"
OIDC_URL="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL}"

echo "== Account ${ACCOUNT_ID}, region ${REGION} =="

# ---- 1. GitHub OIDC identity provider ----------------------
# Lets GitHub Actions authenticate with short-lived tokens.
# AWS validates GitHub's TLS cert against trusted root CAs; the
# thumbprint values are required by the API but no longer used.
if aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "${OIDC_ARN}" >/dev/null 2>&1; then
  echo "OIDC provider already exists"
else
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list \
      "6938fd4d98bab03faadb97b34396831e3780aea1" \
      "1c58a3a8518e8759bf075b76b750d4f2df264fcd" \
    --tags Key=project,Value=bbb-mcp >/dev/null
  echo "OIDC provider created"
fi

# ---- 2. Terraform state bucket -----------------------------
if aws s3api head-bucket --bucket "${STATE_BUCKET}" 2>/dev/null; then
  echo "State bucket already exists: ${STATE_BUCKET}"
else
  aws s3api create-bucket --bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  echo "State bucket created: ${STATE_BUCKET}"
fi
aws s3api put-bucket-versioning --bucket "${STATE_BUCKET}" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "${STATE_BUCKET}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "${STATE_BUCKET}" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'

# ---- 3a. Permissions boundaries (ceilings for stack roles) -----
# The ceiling on every role Terraform creates. The deploy role can
# write those roles' policies, so without a boundary a compromised
# (or simply mistaken) deploy could grant them anything. Effective
# permissions are the INTERSECTION of a role's own policy and its
# boundary, so anything absent here is unreachable no matter what
# the deploy writes.
#
# Deliberately created HERE by a human and NOT by Terraform: the
# deploy role can version policies named bbb-mcp-*, so a
# Terraform-managed boundary could be widened by the very thing it
# constrains. The deploy policy below adds an explicit Deny on
# creating or editing these two policies, which beats that Allow.
#
# TWO boundaries, not one, because the budget action's role is the
# only one that legitimately needs IAM write actions. A single
# union boundary would hand that IAM ceiling to the server role
# too -- and since it can attach/detach policies on
# role/bbb-mcp-server-*, which matches the server role itself, a
# rewritten server policy could then detach the bbb-mcp-bedrock-deny
# cost backstop (that policy denies bedrock:*, so it cannot protect
# itself). Splitting keeps IAM entirely outside the workload
# ceiling. The deploy policy pins each role pattern to its own
# boundary, so neither can be swapped for the other.
#
# Widen either only alongside a real new capability -- a too-tight
# boundary shows up as an AccessDenied at runtime, not at apply time.
#
# Both documents are checked against the roles they cap on every CI run
# (tests/infra-boundaries.test.ts). Each boundary must allow exactly the
# union of the actions granted by the roles it caps, so widening one here
# without a matching change in infra/*.tf fails the build, and so does
# the reverse. Actions only: the Resource scoping below is not compared,
# and is reviewed by eye.

# Workload ceiling: bbb-mcp-server-exec and bbb-mcp-kb-role.
# Logs + Bedrock for the server; corpus reads, vector ops and Titan
# embedding for the knowledge base. No IAM of any kind.
cat > /tmp/boundary-workload.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/bbb-mcp-server:*"
    },
    {
      "Sid": "BedrockRetrieveAndGenerate",
      "Effect": "Allow",
      "Action": [
        "bedrock:Retrieve",
        "bedrock:RetrieveAndGenerate",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CorpusRead",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::bbb-mcp-corpus-*",
        "arn:aws:s3:::bbb-mcp-corpus-*/*"
      ]
    },
    {
      "Sid": "VectorOps",
      "Effect": "Allow",
      "Action": [
        "s3vectors:GetVectorBucket", "s3vectors:GetIndex",
        "s3vectors:ListIndexes", "s3vectors:PutVectors",
        "s3vectors:GetVectors", "s3vectors:QueryVectors",
        "s3vectors:DeleteVectors", "s3vectors:ListVectors"
      ],
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*/index/*"
      ]
    }
  ]
}
EOF

# IAM ceiling: bbb-mcp-budgets-action only. Exactly the four calls
# the budget action makes to attach the deny policy to the server
# role when the cost backstop fires.
cat > /tmp/boundary-iam.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AttachDenyToServerRole",
    "Effect": "Allow",
    "Action": [
      "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:GetRole", "iam:ListAttachedRolePolicies"
    ],
    "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*"
  }]
}
EOF

put_boundary() {  # $1 = policy name, $2 = document path, $3 = description
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/$1"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    echo "Boundary $1 exists; updating to the current definition"
    # Delete every non-default version first, so the 5-version
    # limit can never block a future update: this leaves only the
    # current default, and the new default created below makes two.
    for v in $(aws iam list-policy-versions --policy-arn "$arn" \
        --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$v"
    done
    aws iam create-policy-version --policy-arn "$arn" \
      --policy-document "file://$2" --set-as-default >/dev/null
  else
    aws iam create-policy --policy-name "$1" \
      --policy-document "file://$2" \
      --description "$3" \
      --tags Key=project,Value=bbb-mcp >/dev/null
    echo "Boundary $1 created"
  fi
}

put_boundary bbb-mcp-boundary-workload /tmp/boundary-workload.json \
  "Workload ceiling for the BBB MCP server and knowledge-base roles (no IAM)"
put_boundary bbb-mcp-boundary-iam /tmp/boundary-iam.json \
  "IAM ceiling for the BBB MCP budget-action role"

# ---- 3b. Deploy role (assumed by GitHub Actions via OIDC) --
# Trust is pinned to ONE repo AND the `aws` GitHub environment,
# which has a required-reviewer rule. So this role can only be
# assumed by a workflow run a human has explicitly approved.
cat > /tmp/trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_URL}:aud": "sts.amazonaws.com",
        "${OIDC_URL}:sub": "${GITHUB_SUB}"
      }
    }
  }]
}
EOF

# Scoped deploy permissions: only what Terraform needs to manage
# the bbb-mcp stack. The IAM role actions are scoped to the
# specific roles Terraform creates (bbb-mcp-server-*, bbb-mcp-kb-*,
# bbb-mcp-budgets-*) -- deliberately NOT bbb-mcp-* , which would
# also match this deploy role (bbb-mcp-deploy) and let an assumed
# session rewrite its own policy/trust directly. An explicit Deny
# on the deploy role's own ARN blocks that path even if the
# pattern is ever loosened. Honest limit of this scoping: a deploy
# role that can create Lambda-executable roles, write their
# policies, and deploy code into them is still account-powerful by
# construction (that IS deploying), so the real control on this
# account is that every session of this role requires a human-
# approved workflow run from main -- the scoping below is blast-
# radius hygiene inside a single-purpose account, not a sandbox.
# API Gateway does not support name-scoped ARNs, so it is scoped
# to this region and account (which contains nothing else). The
# Bedrock, S3 Vectors, corpus-bucket, and Budgets statements
# support the docs Q&A (RAG) stack added 2026-08; knowledge-base
# creation and listing cannot be resource-scoped, everything else
# is name- or account-scoped.
cat > /tmp/policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformStateList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::${STATE_BUCKET}"
    },
    {
      "Sid": "TerraformStateRW",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${STATE_BUCKET}/bbb-mcp/*"
    },
    {
      "Sid": "StackRolesCreateWorkloadBounded",
      "Effect": "Allow",
      "Action": ["iam:CreateRole"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*"
      ],
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-workload"
        }
      }
    },
    {
      "Sid": "StackRolesCreateIamBounded",
      "Effect": "Allow",
      "Action": ["iam:CreateRole"],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*",
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-iam"
        }
      }
    },
    {
      "Sid": "StackRolesSetWorkloadBoundary",
      "Effect": "Allow",
      "Action": ["iam:PutRolePermissionsBoundary"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*"
      ],
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-workload"
        }
      }
    },
    {
      "Sid": "StackRolesSetIamBoundary",
      "Effect": "Allow",
      "Action": ["iam:PutRolePermissionsBoundary"],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*",
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-iam"
        }
      }
    },
    {
      "Sid": "StackRolesManage",
      "Effect": "Allow",
      "Action": [
        "iam:DeleteRole", "iam:GetRole",
        "iam:TagRole", "iam:UntagRole",
        "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole", "iam:DetachRolePolicy"
      ],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*"
      ]
    },
    {
      "Sid": "ManagedPolicies",
      "Effect": "Allow",
      "Action": [
        "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy",
        "iam:GetPolicyVersion", "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
        "iam:TagPolicy", "iam:UntagPolicy", "iam:ListEntitiesForPolicy"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-*"
    },
    {
      "Sid": "DenyBoundaryTampering",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicy", "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicy"
      ],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-workload",
        "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-iam"
      ]
    },
    {
      "Sid": "DenyBoundaryRemoval",
      "Effect": "Deny",
      "Action": ["iam:DeleteRolePermissionsBoundary"],
      "Resource": "*"
    },
    {
      "Sid": "DenySelfModification",
      "Effect": "Deny",
      "Action": [
        "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:DeleteRole"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-deploy"
    },
    {
      "Sid": "PassExecRoleToLambdaOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" }
      }
    },
    {
      "Sid": "PassKbRoleToBedrockOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "bedrock.amazonaws.com" }
      }
    },
    {
      "Sid": "PassBudgetsRoleToBudgetsOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "budgets.amazonaws.com" }
      }
    },
    {
      "Sid": "LambdaFunctions",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": [
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:bbb-mcp-*"
      ]
    },
    {
      "Sid": "ApiGateway",
      "Effect": "Allow",
      "Action": "apigateway:*",
      "Resource": "arn:aws:apigateway:${REGION}::/*"
    },
    {
      "Sid": "LambdaLogGroups",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup", "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
        "logs:TagResource", "logs:UntagResource",
        "logs:ListTagsForResource", "logs:DescribeLogGroups"
      ],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*"
    },
    {
      "Sid": "CorpusBucket",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::bbb-mcp-corpus-*",
        "arn:aws:s3:::bbb-mcp-corpus-*/*"
      ]
    },
    {
      "Sid": "VectorStore",
      "Effect": "Allow",
      "Action": "s3vectors:*",
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*/index/*"
      ]
    },
    {
      "Sid": "BedrockKbCreateAndList",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateKnowledgeBase", "bedrock:ListKnowledgeBases"
      ],
      "Resource": "*"
    },
    {
      "Sid": "BedrockKbManage",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetKnowledgeBase", "bedrock:UpdateKnowledgeBase",
        "bedrock:DeleteKnowledgeBase",
        "bedrock:CreateDataSource", "bedrock:GetDataSource",
        "bedrock:UpdateDataSource", "bedrock:DeleteDataSource",
        "bedrock:ListDataSources",
        "bedrock:StartIngestionJob", "bedrock:GetIngestionJob",
        "bedrock:ListIngestionJobs",
        "bedrock:TagResource", "bedrock:UntagResource",
        "bedrock:ListTagsForResource"
      ],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    },
    {
      "Sid": "CostBudget",
      "Effect": "Allow",
      "Action": "budgets:*",
      "Resource": "arn:aws:budgets::${ACCOUNT_ID}:budget/bbb-mcp-*"
    }
  ]
}
EOF

if aws iam get-role --role-name bbb-mcp-deploy >/dev/null 2>&1; then
  echo "Deploy role already exists; refreshing trust + policy"
  aws iam update-assume-role-policy --role-name bbb-mcp-deploy \
    --policy-document file:///tmp/trust.json
else
  aws iam create-role --role-name bbb-mcp-deploy \
    --assume-role-policy-document file:///tmp/trust.json \
    --description "GitHub Actions OIDC deploy role for the BBB MCP stack" \
    --max-session-duration 3600 \
    --tags Key=project,Value=bbb-mcp >/dev/null
  echo "Deploy role created"
fi
aws iam put-role-policy --role-name bbb-mcp-deploy \
  --policy-name bbb-mcp-deploy-policy \
  --policy-document file:///tmp/policy.json
echo "Deploy policy attached"

# ---- 3c. Corpus-sync role (ungated docs publisher) ---------
# Assumed by .github/workflows/corpus-sync.yml on every push to
# main that touches a corpus doc, with no environment gate: the
# merge itself was the editorial decision on that markdown, so a
# second approval would re-review nothing. What makes ungated
# acceptable is how little the role holds -- writes to the corpus
# bucket plus starting/polling ingestion jobs, nothing else. No
# Lambda, no IAM, no Terraform state, no API Gateway.
#
# Created HERE by a human, like the deploy role, and deliberately
# named outside the bbb-mcp-server-*/bbb-mcp-kb-*/bbb-mcp-budgets-*
# patterns the deploy policy's IAM statements are scoped to, so the
# pipeline can neither create this role nor widen it.
# tests/infra-boundaries.test.ts pins its grants and checks that
# separation on every CI run.
#
# Known limit of the trust policy, worth understanding before adding
# workflows to this repo: the subject below pins the main REF, not an
# event or a workflow file, so any job here running on main that asks
# for an OIDC token can assume this role. AWS accepts conditions on
# aud/azp/amr/sub only, so it cannot match GitHub's job_workflow_ref
# claim directly -- and a condition on a claim AWS does not populate
# evaluates false, which denies every run rather than narrowing one.
# So the containment is the role's own narrowness (it can republish
# docs and nothing else) plus a test asserting which workflows may
# request a token at all.
#
# Two ways to narrow further if that stops being enough:
#
#   * Give this role its own GitHub environment with NO required
#     reviewers and its branches limited to main, then pin the subject
#     to ":environment:<name>". Cheap, and keeps the role ungated, but
#     it narrows to jobs that OPT IN -- any workflow naming that
#     environment still gets the subject.
#   * Customise the repo's subject claim to include job_workflow_ref
#     and pin the whole string. This does pin one workflow file, but
#     the customisation is repo-WIDE: it rewrites the subject for every
#     workflow, so the deploy role's trust policy has to change in the
#     same sitting or deploys stop authenticating. GitHub also documents
#     creating the matching cloud-side condition first. How that segment
#     renders under the immutable subject format this repo uses is not
#     documented -- confirm with an OIDC debugger run before pasting a
#     policy that depends on it.
cat > /tmp/corpus-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_URL}:aud": "sts.amazonaws.com",
        "${OIDC_URL}:sub": "${CORPUS_SYNC_SUB}"
      }
    }
  }]
}
EOF

# The knowledge-base id is not known at bootstrap time (Terraform
# generates it), so the ingestion statement is scoped to the account's
# knowledge bases; the account only ever holds this stack's one.
cat > /tmp/corpus-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CorpusWrite",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}/*"
    },
    {
      "Sid": "CorpusList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}"
    },
    {
      "Sid": "Ingest",
      "Effect": "Allow",
      "Action": ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob"],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    }
  ]
}
EOF

if aws iam get-role --role-name bbb-mcp-corpus-sync >/dev/null 2>&1; then
  echo "Corpus-sync role already exists; refreshing trust + policy"
  aws iam update-assume-role-policy --role-name bbb-mcp-corpus-sync \
    --policy-document file:///tmp/corpus-trust.json
else
  aws iam create-role --role-name bbb-mcp-corpus-sync \
    --assume-role-policy-document file:///tmp/corpus-trust.json \
    --description "GitHub Actions OIDC role that publishes the BBB MCP docs corpus" \
    --max-session-duration 3600 \
    --tags Key=project,Value=bbb-mcp >/dev/null
  echo "Corpus-sync role created"
fi
aws iam put-role-policy --role-name bbb-mcp-corpus-sync \
  --policy-name bbb-mcp-corpus-sync-policy \
  --policy-document file:///tmp/corpus-policy.json
echo "Corpus-sync policy attached"

# ---- 4. Zero-spend budget ----------------------------------
# AWS Budgets (without actions) is free. Emails you if actual
# spend ever exceeds one cent.
cat > /tmp/budget.json <<EOF
{
  "BudgetName": "bbb-mcp-zero-spend",
  "BudgetLimit": { "Amount": "0.01", "Unit": "USD" },
  "BudgetType": "COST",
  "TimeUnit": "MONTHLY"
}
EOF
cat > /tmp/budget-notify.json <<EOF
[{
  "Notification": {
    "NotificationType": "ACTUAL",
    "ComparisonOperator": "GREATER_THAN",
    "Threshold": 100,
    "ThresholdType": "PERCENTAGE"
  },
  "Subscribers": [
    { "SubscriptionType": "EMAIL", "Address": "${ALERT_EMAIL}" }
  ]
}]
EOF
if aws budgets describe-budget --account-id "${ACCOUNT_ID}" \
    --budget-name bbb-mcp-zero-spend --region us-east-1 >/dev/null 2>&1; then
  echo "Budget already exists"
else
  aws budgets create-budget --account-id "${ACCOUNT_ID}" \
    --budget file:///tmp/budget.json \
    --notifications-with-subscribers file:///tmp/budget-notify.json \
    --region us-east-1
  echo "Zero-spend budget created (alerts -> ${ALERT_EMAIL})"
fi

rm -f /tmp/trust.json /tmp/policy.json /tmp/budget.json /tmp/budget-notify.json \
      /tmp/boundary-workload.json /tmp/boundary-iam.json \
      /tmp/corpus-trust.json /tmp/corpus-policy.json

echo
echo "=========================================================="
echo "Bootstrap complete."
echo
echo "  Trust policy pinned to OIDC subject:"
echo "    ${GITHUB_SUB}"
echo "  (verify this matches the repo's OIDC settings preview)"
echo
echo "Now add these in GitHub (Step 4):"
echo
echo "  Repository variables (Settings > Secrets and variables"
echo "  > Actions > Variables tab > New repository variable):"
echo
echo "    AWS_ROLE_ARN      = arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-deploy"
echo "    AWS_REGION        = ${REGION}"
echo "    TF_STATE_BUCKET   = ${STATE_BUCKET}"
echo
echo "  Plus two more (values from the Vercel project env or"
echo "  .env.local -- see Step 4 of the runbook):"
echo
echo "    SUPABASE_URL      (= NEXT_PUBLIC_SUPABASE_URL)"
echo "    SUPABASE_ANON_KEY (= NEXT_PUBLIC_SUPABASE_ANON_KEY)"
echo
echo "  For the ungated corpus-sync workflow. The two ids exist only"
echo "  after the stack's first apply; if either prints as absent,"
echo "  re-run just this lookup afterwards (or copy them from the"
echo "  deploy run's 'Show outputs' step):"
echo
KB_ID=$(aws bedrock-agent list-knowledge-bases \
  --query "knowledgeBaseSummaries[?name=='bbb-mcp-docs'].knowledgeBaseId" \
  --output text 2>/dev/null)
DS_ID=""
if [ -n "${KB_ID}" ] && [ "${KB_ID}" != "None" ]; then
  DS_ID=$(aws bedrock-agent list-data-sources \
    --knowledge-base-id "${KB_ID}" \
    --query "dataSourceSummaries[?name=='bbb-mcp-docs-corpus'].dataSourceId" \
    --output text 2>/dev/null)
fi
echo "    AWS_CORPUS_SYNC_ROLE_ARN = arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-corpus-sync"
echo "    MCP_KB_ID                = ${KB_ID:-<absent until first apply>}"
echo "    MCP_DATA_SOURCE_ID       = ${DS_ID:-<absent until first apply>}"
echo "    MCP_CORPUS_BUCKET        = bbb-mcp-corpus-${ACCOUNT_ID}"
echo "=========================================================="
```

4. Copy the variable values the script prints at the end; Step 4 needs
   them.

**A note on what the trust policy pins.** With the immutable subject claim
enabled (Step 3.1), the deploy role trusts a GitHub identity that embeds
the account's and repository's permanent numeric IDs, not just their
names. A recycled or squatted name can therefore never mint a matching
token, even if the account or repo were deleted and re-registered by
someone else. One operational consequence: renaming or transferring the
repository changes the subject's name portion, so deploys would stop
authenticating (a safe, fail-closed outcome) until the trust policy is
updated to the new subject; re-running the Step 3 script with an updated
`GITHUB_SUB` refreshes it in place.

## Step 4 -- GitHub environment and variables (~10 min)

All of this is in the repo:
<https://github.com/jtzingsheim1/brisbane-bowser-beater/settings>.

1. **Create the gated environment.** Settings, **Environments**, **New
   environment**, name it exactly `aws`.
   - Tick **Required reviewers** and add yourself, then **Save protection
     rules**. Every deploy will pause until you approve it in the Actions
     UI.
   - Under **Deployment branches and tags**, choose **Selected branches and
     tags** and add a rule for `main`. Only workflow runs from `main` can
     use the environment.

   > **This step is the human-approval gate.** AWS trusts any workflow run
   > carrying the `environment:aws` identity; the "a human approves every
   > deploy" property comes entirely from the required-reviewer rule you set
   > here, not from AWS. If you create the `aws` environment without a
   > required reviewer, deploys will run unattended. Do not skip the
   > reviewer tick.
2. **Add the repository variables.** Settings, **Secrets and variables**,
   **Actions**, **Variables** tab, **New repository variable**. Create the
   three variables exactly as printed by the CloudShell script:
   - `AWS_ROLE_ARN`
   - `AWS_REGION`
   - `TF_STATE_BUCKET`

   Then two more, so the deployed server knows where to read its data.
   Both values already exist in the Vercel project's environment variables
   (Vercel dashboard, the BBB project, Settings, Environment Variables),
   or in your local `.env.local`:
   - `SUPABASE_URL` (same value as `NEXT_PUBLIC_SUPABASE_URL`)
   - `SUPABASE_ANON_KEY` (same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY`)

   Then four more, for the ungated corpus-sync workflow, also as printed
   by the script (the two ids exist only after the stack's first apply;
   they also appear in the deploy run's "Show outputs" step, and change
   if the stack is ever destroyed and rebuilt -- update the variables
   then):

   - `AWS_CORPUS_SYNC_ROLE_ARN`
   - `MCP_KB_ID`
   - `MCP_DATA_SOURCE_ID`
   - `MCP_CORPUS_BUCKET`

   These are variables rather than secrets on purpose: none of them are
   sensitive. A role ARN is not a credential (assuming the deploy role
   requires a GitHub OIDC token from an approved run of this repo's `aws`
   environment, and the corpus-sync role one from a job on this repo's
   `main`), and the Supabase URL and anon key are the publishable
   (low-privilege) tier, with Postgres grants/RLS limiting the anon role
   to aggregate read paths only.

That's it. No AWS keys were created, and none will be. When the deploy
workflow first runs you will see a review request in the repo's Actions tab;
approving it is what releases short-lived credentials to that single run.

---

## Update for the docs Q&A (RAG) stack (2026-08, ~15 min once)

The RAG extension (see `docs/mcp-rag-design.md`) adds Bedrock, S3 Vectors,
a corpus bucket, and a cost-backstop budget action to the Terraform stack.
Before its first deploy, three one-time things need a human:

1. **Refresh the deploy role.** Re-run the Step 3 CloudShell script above
   (it is idempotent; the policy it writes now includes the RAG
   permissions). Nothing else in the script changes anything on a re-run.
2. **Enable the models in Bedrock.** In the console (region Sydney),
   open **Amazon Bedrock, Model catalog**:
   - **Claude Haiku 4.5** (Anthropic): request access. First-time
     Anthropic use requires a short use-case form, and the Marketplace
     subscription needs the enabling identity to have Marketplace
     permissions and the account a payment method. An optional playground
     invoke confirms it end to end (the first invoke can take up to ~15
     minutes to auto-subscribe).
   - **Titan Text Embeddings V2** (Amazon): no form; just confirm it
     shows as available.
3. **Add one repository variable.** In GitHub, alongside the Step 4
   variables: `ALERT_EMAIL` = the email that should hear when the cost
   backstop triggers (the budget action's required subscriber).

Two budget notes:

- The Step 3 **zero-spend budget will now alert every month** once real
  (tiny) Bedrock spend begins. That is it working as designed; keep it as
  a heartbeat, or delete/raise it in the console when it becomes noise.
- After the first apply, verify in **AWS Budgets** that the
  `bbb-mcp-monthly` budget's action shows **Standby**: that is the armed
  state of the layer that denies Bedrock access to the server role at
  100% of budget.

**If the backstop ever fires** (docs tools start returning errors and the
budget emails you): the deny policy stays attached across month rollover
by design -- nothing un-denies itself. To restore service after deciding
the spend was acceptable, detach it in CloudShell and re-arm the action:

```bash
aws iam detach-role-policy --role-name bbb-mcp-server-exec \
  --policy-arn arn:aws:iam::$(aws sts get-caller-identity \
  --query Account --output text):policy/bbb-mcp-bedrock-deny
```

then in the Budgets console reset the `bbb-mcp-monthly` action and confirm
it shows **Standby** again. `terraform destroy` still works in the
triggered state (the server role force-detaches policies on destroy), so
the one-command decommission is unaffected.

---

## Update for the permissions boundaries (2026-08, ~5 min once)

**Already done on the live account** (2026-08-23, deploy run 8). The steps
stay here because rebuilding the account from scratch needs them, and
because re-running the Step 3 paste is how any future boundary change is
applied.

Adds a permissions boundary to each of the three roles Terraform creates
(`bbb-mcp-server-exec`, `bbb-mcp-kb-role`, `bbb-mcp-budgets-action`). A
boundary is a ceiling: a role's effective permissions become the
intersection of its own policy and its boundary, so anything the boundary
omits is unreachable even if the deploy role writes a wider policy. It
closes the standing item that the deploy role can rewrite the stack roles'
policies (issue #101).

**Order matters.** The deploy role cannot attach a boundary until it has
`iam:PutRolePermissionsBoundary`, and the boundary policies must exist
before anything references them. Doing the apply first fails the same way
the 2026-08-22 `iam:UpdateRoleDescription` failure did.

1. **Re-run the Step 3 CloudShell script above.** It is idempotent. On this
   run it creates the two boundary policies (new section 3a) and refreshes
   the deploy policy so it can attach each one to its own set of roles.
   Nothing else changes on a re-run.
2. **Then run the deploy workflow** (`apply`). Terraform attaches the
   boundaries to the three roles; expect three in-place role updates and no
   other changes.

If the apply reports `AccessDenied` on `iam:PutRolePermissionsBoundary`,
step 1 did not take -- re-run it and check the output says each boundary was
created or updated.

**Two boundaries, not one, and that split is the point.** The budget
action's role is the only one that legitimately needs IAM write actions,
and those actions are scoped to `role/bbb-mcp-server-*` -- a pattern that
matches the server role itself. A single shared ceiling would therefore
have let a rewritten server policy detach `bbb-mcp-bedrock-deny`, the cost
backstop, which denies `bedrock:*` only and so cannot protect itself. So:

- `bbb-mcp-boundary-workload` (server + knowledge-base roles): CloudWatch
  Logs writes, Bedrock retrieve/generate plus inference-profile lookup,
  corpus-bucket reads, and S3 Vectors operations. **No IAM actions at all.**
- `bbb-mcp-boundary-iam` (budget-action role only): exactly the four IAM
  calls that role makes to attach the deny policy when the backstop fires.

The deploy policy pins each role-name pattern to its own boundary in both
the `iam:CreateRole` condition and the `iam:PutRolePermissionsBoundary`
grant, so a server or knowledge-base role can never be given the IAM
ceiling. Widening either is a deliberate act that belongs in the same
change as whatever new capability needs it; a boundary that is too tight
surfaces as an `AccessDenied` at runtime, not at apply time.

Three properties worth knowing, because they are what make this more than
paperwork:

- The boundary policies are created by this script (a human, in CloudShell),
  **not** by Terraform. The deploy role can version policies named
  `bbb-mcp-*`, so Terraform-managed boundaries could be widened by the very
  thing they constrain. The deploy policy carries an explicit `Deny` on
  creating *or* editing either boundary policy, which beats that `Allow` --
  including the case where a boundary is missing and could otherwise be
  replaced by a permissive policy of the same name.
- The deploy role has no `iam:DeleteRolePermissionsBoundary` anywhere, and
  its `iam:CreateRole` is conditioned on the matching boundary being set --
  so it can neither strip the ceiling from an existing role nor create a
  fresh unbounded one.
- That last property makes this change **one-way through the pipeline**:
  removing `permissions_boundary` from a role in the `.tf` makes Terraform
  call `DeleteRolePermissionsBoundary`, which the deploy role is denied, so
  the apply fails with AccessDenied. That is deliberate -- an attacker with
  the pipeline should not be able to lift the ceiling -- but it means
  reverting has to be human-driven: remove the `DenyBoundaryRemoval`
  statement from the deploy policy in CloudShell first, then apply.

`terraform destroy` is unaffected: deleting a role with a boundary attached
needs no extra permission.

The two boundary documents in section 3a and the role policies in
`infra/*.tf` are separate artifacts that can drift apart in either
direction, so CI compares them (`tests/infra-boundaries.test.ts`): each
boundary must allow exactly the union of the actions granted to the roles
it caps. A role policy that outgrew its boundary would otherwise fail only
as a runtime `AccessDenied`, and a boundary that outgrew its roles would
not fail at all. The same test checks the pinning clauses in the deploy
policy below: no role creation or re-capping without an
`iam:PermissionsBoundary` condition, each role name eligible for exactly
one ceiling, the Deny statements intact, and no path by which the deploy
role could rewrite its own permissions.

---

## Update for the ungated corpus sync (2026-08, ~5 min once)

Adds the `bbb-mcp-corpus-sync` role (new section 3c) so
`.github/workflows/corpus-sync.yml` can publish doc changes to the
knowledge base on merge, without the manual deploy that used to be the
only re-ingest path. The same paste narrows the workload boundary's Logs
resource to the one log group the stack actually grants on (the deferred
issue #101 item).

1. **Re-run the Step 3 CloudShell script above.** Idempotent as always. On
   this run it creates the corpus-sync role and refreshes the workload
   boundary; nothing else changes.
2. **Add the four repository variables** the script prints at the end
   (listed in Step 4.2): `AWS_CORPUS_SYNC_ROLE_ARN`, `MCP_KB_ID`,
   `MCP_DATA_SOURCE_ID`, `MCP_CORPUS_BUCKET`.

No environment gate for this workflow, on purpose: the merge that landed a
doc was the editorial decision, and the role is too narrow to touch the
deployed stack (section 3c's comment carries the reasoning;
`tests/infra-boundaries.test.ts` and `tests/corpus-sync-workflow.test.ts`
hold the role and workflow to it). The gated deploy workflow still syncs
the corpus after each apply, so infra-driven corpus changes (a rebuilt
knowledge base, say) do not wait for the next doc merge.

---

## Afterwards: retrieving the MCP API keys (post-deploy, ~2 min)

The Terraform stack creates two API keys that gate the MCP endpoint. Neither
is ever printed in workflow logs. After a successful deploy, open CloudShell
(still in ap-southeast-2) and run:

```bash
# Private operator key
aws apigateway get-api-keys --name-query bbb-mcp-key --include-values \
  --query "items[?name=='bbb-mcp-key'].value | [0]" --output text

# Key for general distribution
aws apigateway get-api-keys --name-query bbb-mcp-key-demo --include-values \
  --query "items[?name=='bbb-mcp-key-demo'].value | [0]" --output text
```

Note the exact-name filter in the query. `--name-query` is a PREFIX match, so
`bbb-mcp-key` alone matches both keys and an `items[0]` shortcut would return
whichever the API happened to list first. Match on `name` explicitly.

Store both in your password manager. Callers send one as the `x-api-key`
header. The two are metered separately by the usage plan, which is the point:
the distributed key can be rotated on a whim or after abuse without touching
the private one, and exhausting one never affects the other.

Rotation is self-serve: delete the key in CloudShell (or have Terraform
replace it), re-apply, then re-run the matching command above.

## Decommissioning (for reference, not now)

The whole stack is one Terraform root module, so teardown is:

1. Run the deploy workflow in destroy mode (or `terraform destroy` from a
   session), which removes the Lambda, API, key, and logs.
2. Optionally, in CloudShell: delete the deploy role, the corpus-sync role
   (neither is Terraform-managed, so both outlive a destroy -- and the
   corpus-sync role keeps trusting GitHub OIDC, with a grant on the
   deterministically-named corpus bucket that would go live again if the
   stack were ever rebuilt), the OIDC provider, state bucket, budget, and
   the two `bbb-mcp-boundary-*` policies (the reverse of Step 3). Delete the boundary policies LAST, and only as part of a
   full teardown: while the deploy role still exists, its `iam:CreateRole`
   is conditioned on a boundary that would no longer be there, so a later
   rebuild fails at apply time until Step 3 is re-run to recreate them.
3. The account itself can then be closed from the console if it is no
   longer wanted.
