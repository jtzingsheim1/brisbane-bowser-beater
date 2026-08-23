# AWS bootstrap runbook (one-time, ~30-45 minutes)

This is the one-time, human-in-the-loop setup for the BBB MCP server's AWS
account. Everything here happens exactly once. After this sitting, every
deploy runs through GitHub Actions with short-lived OIDC credentials, and
nothing else ever needs the AWS console.

What you end up with:

- A fresh AWS account with MFA on the root user and **zero long-lived access
  keys**. No IAM users exist at all. The only programmatic access to the
  account is a single deploy role that GitHub Actions assumes via OIDC, and
  assuming it requires a workflow run that you have personally approved.
- An S3 bucket for Terraform state (versioned, encrypted, public access
  blocked).
- A zero-spend budget that emails you if the account ever accrues charges.
- A GitHub environment named `aws` with you as required reviewer, plus three
  repository variables the deploy workflow reads.

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

# ---- 3a. Permissions boundary (ceiling for stack roles) ----
# The ceiling on every role Terraform creates. The deploy role can
# write those roles' policies, so without a boundary a compromised
# (or simply mistaken) deploy could grant them anything. Effective
# permissions are the INTERSECTION of a role's own policy and this
# boundary, so anything absent here is unreachable no matter what
# the deploy writes.
#
# Deliberately created HERE by a human and NOT by Terraform: the
# deploy role can version policies named bbb-mcp-*, so a
# Terraform-managed boundary could be widened by the very thing it
# constrains. The deploy policy below adds an explicit Deny on
# editing this policy, which beats that Allow.
#
# Contents = the union of what the three stack roles legitimately
# need (server-exec: logs + Bedrock retrieve/generate; kb: corpus
# read + vector ops + Titan embed; budgets-action: attach the deny
# policy to the server role). Widen it only alongside a real new
# capability -- a too-tight boundary shows up as an AccessDenied at
# runtime, not at apply time.
cat > /tmp/boundary.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/bbb-mcp-*"
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
    },
    {
      "Sid": "BudgetActionAttachesDenyToServerRole",
      "Effect": "Allow",
      "Action": [
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:GetRole", "iam:ListAttachedRolePolicies"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*"
    }
  ]
}
EOF

BOUNDARY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary"
if aws iam get-policy --policy-arn "${BOUNDARY_ARN}" >/dev/null 2>&1; then
  echo "Permissions boundary exists; updating to the current definition"
  # Keep at most one non-default version so the 5-version limit
  # can never block a future update.
  for v in $(aws iam list-policy-versions --policy-arn "${BOUNDARY_ARN}" \
      --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
    aws iam delete-policy-version --policy-arn "${BOUNDARY_ARN}" \
      --version-id "$v"
  done
  aws iam create-policy-version --policy-arn "${BOUNDARY_ARN}" \
    --policy-document file:///tmp/boundary.json --set-as-default >/dev/null
else
  aws iam create-policy --policy-name bbb-mcp-boundary \
    --policy-document file:///tmp/boundary.json \
    --description "Permissions ceiling for every role the BBB MCP deploy role creates" \
    --tags Key=project,Value=bbb-mcp >/dev/null
  echo "Permissions boundary created"
fi

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
      "Sid": "StackRolesCreateBoundedOnly",
      "Effect": "Allow",
      "Action": ["iam:CreateRole"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*"
      ],
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary"
        }
      }
    },
    {
      "Sid": "StackRolesSetBoundary",
      "Effect": "Allow",
      "Action": ["iam:PutRolePermissionsBoundary"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-budgets-*"
      ],
      "Condition": {
        "ArnEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary"
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
        "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion", "iam:DeletePolicy"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary"
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

rm -f /tmp/trust.json /tmp/policy.json /tmp/budget.json /tmp/budget-notify.json

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
echo "=========================================================="
```

4. Copy the three variable values the script prints at the end; Step 4 needs
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

   These are variables rather than secrets on purpose: none of them are
   sensitive. A role ARN is not a credential (assuming the role requires a
   GitHub OIDC token from an approved run of this repo's `aws`
   environment), and the Supabase URL and anon key are the publishable
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

## Update for the permissions boundary (2026-08, ~5 min once)

Adds a permissions boundary to the three roles Terraform creates
(`bbb-mcp-server-exec`, `bbb-mcp-kb-role`, `bbb-mcp-budgets-action`). The
boundary is a ceiling: a role's effective permissions become the
intersection of its own policy and the boundary, so anything the boundary
omits is unreachable even if the deploy role writes a wider policy. It
closes the standing item that the deploy role can rewrite the stack roles'
policies (issue #101).

**Order matters.** The deploy role cannot attach a boundary until it has
`iam:PutRolePermissionsBoundary`, and the boundary policy must exist before
anything references it. Doing the apply first fails the same way the
2026-08-22 `iam:UpdateRoleDescription` failure did.

1. **Re-run the Step 3 CloudShell script above.** It is idempotent. On this
   run it creates the `bbb-mcp-boundary` policy (new section 3a) and
   refreshes the deploy policy so it can attach that boundary -- and only
   that boundary -- to the stack roles. Nothing else changes on a re-run.
2. **Then run the deploy workflow** (`apply`). Terraform attaches the
   boundary to the three roles; expect three in-place role updates and no
   other changes.

If the apply reports `AccessDenied` on `iam:PutRolePermissionsBoundary`,
step 1 did not take -- re-run it and check the output says the boundary was
created or updated.

What the boundary allows, and why it is exactly this: the union of what the
three roles legitimately do -- CloudWatch Logs writes for the Lambda,
Bedrock retrieve/generate plus inference-profile lookup, corpus-bucket
reads and S3 Vectors operations for the knowledge base, and the four IAM
actions the budget action needs to attach the deny policy to the server
role. Nothing else. Widening it is a deliberate act that belongs in the
same change as whatever new capability needs it; a boundary that is too
tight surfaces as an `AccessDenied` at runtime, not at apply time.

Two properties worth knowing, because they are what make this more than
paperwork:

- The boundary policy is created by this script (a human, in CloudShell),
  **not** by Terraform. The deploy role can version policies named
  `bbb-mcp-*`, so a Terraform-managed boundary could be widened by the very
  thing it constrains. The deploy policy carries an explicit `Deny` on
  editing `bbb-mcp-boundary`, which beats that `Allow`.
- The deploy role has no `iam:DeleteRolePermissionsBoundary` anywhere, and
  its `iam:CreateRole` is conditioned on the boundary being set -- so it can
  neither strip the ceiling from an existing role nor create a fresh
  unbounded one.

`terraform destroy` is unaffected: deleting a role with a boundary attached
needs no extra permission.

---

## Afterwards: retrieving the MCP API key (post-deploy, ~2 min)

The Terraform stack creates the API key that gates the MCP endpoint. It is
never printed in workflow logs. After the first successful deploy, open
CloudShell (still in ap-southeast-2) and run:

```bash
aws apigateway get-api-keys --name-query bbb-mcp-key --include-values \
  --query "items[0].value" --output text
```

Store it in your password manager. Anyone using the MCP server sends it as
the `x-api-key` header. Rotation is self-serve at any time: delete the key
in CloudShell or ask Claude to rotate it via Terraform, then re-run the
command above.

## Decommissioning (for reference, not now)

The whole stack is one Terraform root module, so teardown is:

1. Run the deploy workflow in destroy mode (or `terraform destroy` from a
   session), which removes the Lambda, API, key, and logs.
2. Optionally, in CloudShell: delete the deploy role, OIDC provider, state
   bucket, and budget (the reverse of Step 3).
3. The account itself can then be closed from the console if it is no
   longer wanted.
