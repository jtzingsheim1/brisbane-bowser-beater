# AWS bootstrap runbook (one-time, ~30-45 minutes)

This is the human-in-the-loop setup for the BBB MCP server's AWS account.
Steps 1, 2 and 4 happen once. Step 3 is one idempotent CloudShell paste:
the first sitting runs it, it runs once more after the stack's first apply
(to arm the cost backstop, section 3d), and every later change to a
hand-made resource is applied by re-pasting it (the "Update for ..."
sections below record each re-paste). Outside those pastes, every deploy
runs through GitHub Actions with short-lived OIDC credentials.

What you end up with:

- A fresh AWS account with MFA on the root user and **zero long-lived access
  keys**. No IAM users exist at all. The only programmatic access to the
  account is three roles GitHub Actions assumes via OIDC:
  - an update role (`bbb-mcp-update`, section 3e) that jobs in the `aws`
    environment assume without approval, and that can only replace the
    Lambda's code, retag stack resources, republish the docs corpus and
    write Terraform state;
  - a deploy role (`bbb-mcp-deploy`, section 3b) for every other change,
    which only a workflow run you have approved in the `aws-gated`
    environment can assume;
  - a narrow corpus-sync role (`bbb-mcp-corpus-sync`, section 3c: bucket
    writes plus ingestion only) that jobs running on main can assume
    without a gate.
- An S3 bucket for Terraform state (versioned, encrypted, public access
  blocked).
- A zero-spend budget that emails you if the account ever accrues charges.
- Two customer-managed permissions-boundary policies
  (`bbb-mcp-boundary-workload`, `bbb-mcp-boundary-iam`) that cap what the
  roles Terraform creates, and the backstop's own role, can ever hold.
  Neither deploy role can create, edit, remove or swap them, which is
  what makes them a real ceiling rather than a default.
- A human-owned cost backstop (section 3d, all named `bbb-backstop-*`): a
  monthly budget whose action, at 100% of actual spend, attaches a deny
  policy to every role that can spend. Neither deploy role can change it.
- Two GitHub environments, `aws` (no reviewer) and `aws-gated` (you as
  required reviewer), plus the repository variables the workflows read.

Steps 1 and 2 are console clicking. Step 3 is one paste into CloudShell
(re-run once after the first apply). Step 4 is GitHub settings. Have your
password manager, phone, and a credit/debit card ready.

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
   confirm the previewed subject matches the `GITHUB_REPO_SUB` value in
   the script below (name@numeric-id for both the account and the repo).
   The preview shows only that prefix. GitHub appends the tail at token
   time from the job's context (`:environment:aws`,
   `:environment:aws-gated`, or `:ref:refs/heads/main` for a job with no
   environment), and the script derives all three subjects from the one
   prefix. This permanently ties the AWS trust policies to the repo's
   numeric IDs, so a recycled account or repo name can never mint matching
   tokens. Treat the toggle as one-way. If the previewed prefix differs
   from the script's in any way, set `GITHUB_REPO_SUB` to the previewed
   prefix before running.
2. In the AWS console's top-right region selector, choose
   **Asia Pacific (Sydney) ap-southeast-2**.
3. Open **CloudShell** (the terminal icon in the top toolbar, or search
   "CloudShell").
4. **Edit the variables at the top** of the script below (your alert
   email, and the backstop's monthly limit if 5 USD does not suit; the
   subject prefix is prefilled from this repo's IDs, and
   `DEPLOY_ROLE_STAGE` stays `final` except during the one migration that
   says otherwise), then paste the whole thing into CloudShell and press
   Enter.

The script is idempotent: if a resource already exists it says so and moves
on (or refreshes it to the definition below), so it is safe to re-run if
anything is interrupted.

**Run it once more after the stack's first apply.** The cost backstop's
action (section 3d) names roles Terraform creates (`bbb-mcp-server-exec`,
`bbb-mcp-kb-role`), so on a fresh account section 3d finds them missing,
says so, and skips. Re-pasting the script after the first deploy arms it.

```bash
# ============================================================
# BBB MCP bootstrap. Region: ap-southeast-2 (Sydney).
# EDIT THESE LINES, then paste the whole script.
# ============================================================
ALERT_EMAIL="you@example.com"   # billing + backstop alert email
BACKSTOP_LIMIT_USD="5.0"        # section 3d: monthly budget, USD
# The immutable OIDC subject PREFIX for this repo (Step 3.1). Numeric
# IDs are the permanent GitHub account and repo IDs. Must exactly
# match the repo's OIDC settings preview; GitHub adds the tail at
# token time.
GITHUB_REPO_SUB="repo:jtzingsheim1@43869157/brisbane-bowser-beater@1245389373"
# "final" for every normal run. "transition" only for Paste A in
# "Update for auto-deploy" (live account, before that merge): it
# adds the aws-gated subject to the deploy role's trust, keeps the
# aws subject, and leaves the deploy role's POLICY untouched.
DEPLOY_ROLE_STAGE="final"
# ============================================================
# The three subjects, each derived from the one prefix above, so no
# re-run can leave two trust policies disagreeing on the repo.
#  - deploy role (3b): jobs in the reviewer-gated aws-gated environment
DEPLOY_SUB="${GITHUB_REPO_SUB}:environment:aws-gated"
#  - update role (3e): jobs in the aws environment (no reviewer,
#    main only)
UPDATE_SUB="${GITHUB_REPO_SUB}:environment:aws"
#  - corpus-sync role (3c): any job on main with NO environment. This
#    matches by REF, not by event: any job in the repo running on main
#    that requests an OIDC token without an environment sends it, not
#    only the corpus-sync workflow's pushes. See section 3c.
CORPUS_SYNC_SUB="${GITHUB_REPO_SUB}:ref:refs/heads/main"

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

# ---- 3a. Permissions boundaries (ceilings for capped roles) ----
# The ceiling on every role Terraform creates, and on the
# backstop's own role. The deploy role can write the stack roles'
# policies, so without a boundary a compromised (or simply
# mistaken) deploy could grant them anything. Effective
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
# TWO boundaries, not one, because the backstop's action role
# (bbb-backstop-action, section 3d) is the only role that
# legitimately needs IAM write actions, and those actions target
# the server and knowledge-base roles themselves. A single union
# boundary would hand that IAM ceiling to those roles too, and a
# rewritten server policy could then detach the backstop deny
# (which denies spending actions, not IAM, so it cannot protect
# itself). Splitting keeps IAM entirely outside the workload
# ceiling. The deploy policy lets the pipeline create roles under
# the workload ceiling only; nothing but this script creates a
# role under the IAM one.
#
# Widen either only alongside a real new capability -- a too-tight
# boundary shows up as an AccessDenied at runtime, not at apply time.
#
# Both documents are checked against the roles they cap on every CI run
# (tests/infra-boundaries.test.ts). Each boundary must allow exactly the
# union of the actions granted by the roles it caps (the stack roles in
# infra/*.tf, the backstop role in section 3d), so widening one here
# without a matching role change fails the build, and so does the
# reverse. Actions only, with one exception: the workload boundary's
# model ARNs are compared exactly with the locals in infra/rag.tf.

# Workload ceiling: bbb-mcp-server-exec and bbb-mcp-kb-role.
# Logs + Bedrock for the server; corpus reads, vector ops and Titan
# embedding for the knowledge base. No IAM of any kind.
#
# Bedrock is split in two. Retrieve and RetrieveAndGenerate are not
# resource-scopeable, so they stay on "*". Every model call is
# limited to exactly two models: the Titan embedding model and Claude
# Haiku through the au. inference profile, whose foundation-model
# ARN is listed in both of the profile's destination regions. These
# ARNs mirror titan_embed_arn, rag_profile_arn and
# rag_model_region_arns in infra/rag.tf. A mismatch breaks ask_docs
# (or ingestion) the moment this is pasted, so a model change lands
# here first and is re-pasted BEFORE the deploy that switches models.
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
      "Sid": "BedrockRetrieve",
      "Effect": "Allow",
      "Action": ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"],
      "Resource": "*"
    },
    {
      "Sid": "BedrockTwoModelsOnly",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": [
        "arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0",
        "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/au.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:ap-southeast-4::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
      ]
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

# IAM ceiling: bbb-backstop-action only (section 3d). Exactly the
# four calls the budget action makes to attach (and, on reset,
# detach) the deny policy, on exactly the four roles it targets.
cat > /tmp/boundary-iam.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AttachDenyToTargetRoles",
    "Effect": "Allow",
    "Action": [
      "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:GetRole", "iam:ListAttachedRolePolicies"
    ],
    "Resource": [
      "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-exec",
      "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-role",
      "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-update",
      "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-corpus-sync"
    ]
  }]
}
EOF

put_managed_policy() {  # $1 = policy name, $2 = document path, $3 = description
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/$1"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    echo "Policy $1 exists; updating to the current definition"
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
    echo "Policy $1 created"
  fi
}

put_managed_policy bbb-mcp-boundary-workload /tmp/boundary-workload.json \
  "Workload ceiling for the BBB MCP server and knowledge-base roles (no IAM)"
put_managed_policy bbb-mcp-boundary-iam /tmp/boundary-iam.json \
  "IAM ceiling for the BBB MCP cost-backstop action role"

# ---- 3b. Deploy role (gated; assumed by GitHub Actions via OIDC) --
# Trust is pinned to ONE repo AND the `aws-gated` GitHub environment,
# which has a required-reviewer rule with admin bypass off. So this
# role can only be assumed by a workflow run a human has explicitly
# approved. It handles every change the update role (3e) cannot:
# IAM, API Gateway, Lambda configuration, new, replaced or deleted
# resources, and destroy.
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
        "${OIDC_URL}:sub": "${DEPLOY_SUB}"
      }
    }
  }]
}
EOF

# Used ONLY by Paste A in "Update for auto-deploy" (live account,
# before that merge): the deploy role accepts both the old `aws`
# subject (still reviewer-gated at that point) and the new
# `aws-gated` one, so the merge's runs can use either. Paste B
# replaces it with /tmp/trust.json above.
cat > /tmp/deploy-trust-transition.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_URL}:aud": "sts.amazonaws.com",
        "${OIDC_URL}:sub": ["${UPDATE_SUB}", "${DEPLOY_SUB}"]
      }
    }
  }]
}
EOF

# Scoped deploy permissions: only what Terraform needs to manage
# the bbb-mcp stack. The IAM role actions are scoped to the
# specific roles Terraform creates (bbb-mcp-server-*, bbb-mcp-kb-*)
# -- deliberately NOT bbb-mcp-* , which would also match this
# deploy role (bbb-mcp-deploy) and the hand-made update and
# corpus-sync roles, and let an assumed session rewrite them. An
# explicit Deny on the deploy role's own ARN blocks the self path
# even if the pattern is ever loosened. Honest limit of this
# scoping: a deploy role that can create Lambda-executable roles,
# write their policies, and deploy code into them is still
# account-powerful by construction (that IS deploying), so the real
# control on this account is that every session of this role
# requires a human-approved workflow run from main -- the scoping
# below is blast-radius hygiene inside a single-purpose account,
# not a sandbox. API Gateway does not support name-scoped ARNs, so
# it is scoped to this region and account (which contains nothing
# else). The Bedrock, S3 Vectors and corpus-bucket statements
# support the docs Q&A (RAG) stack added 2026-08; knowledge-base
# creation and listing cannot be resource-scoped, everything else
# is name- or account-scoped.
#
# The cost backstop (section 3d) is out of reach: no Allow here
# matches a bbb-backstop-* name except the two budget reads the
# smoke test uses, and the last two statements Deny every write to
# it, plus detaching its deny policy from any role. A detach names
# the role, not the policy, so that Deny is keyed on the
# iam:PolicyARN condition rather than on a resource.
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
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*"
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
      "Sid": "BackstopRead",
      "Effect": "Allow",
      "Action": ["budgets:ViewBudget", "budgets:DescribeBudgetAction*"],
      "Resource": "arn:aws:budgets::${ACCOUNT_ID}:budget/bbb-backstop-*"
    },
    {
      "Sid": "DenyBackstopWrites",
      "Effect": "Deny",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
        "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
        "iam:TagRole", "iam:UntagRole", "iam:PassRole",
        "iam:CreatePolicy", "iam:DeletePolicy",
        "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy", "iam:UntagPolicy",
        "budgets:ModifyBudget",
        "budgets:CreateBudgetAction", "budgets:UpdateBudgetAction",
        "budgets:DeleteBudgetAction", "budgets:ExecuteBudgetAction",
        "budgets:TagResource", "budgets:UntagResource"
      ],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-backstop-*",
        "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-*",
        "arn:aws:budgets::${ACCOUNT_ID}:budget/bbb-backstop-*"
      ]
    },
    {
      "Sid": "DenyBackstopDetach",
      "Effect": "Deny",
      "Action": ["iam:DetachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "iam:PolicyARN": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-*"
        }
      }
    }
  ]
}
EOF

if [ "${DEPLOY_ROLE_STAGE}" = "transition" ]; then
  # Paste A only: widen the trust, leave the policy as it is.
  aws iam update-assume-role-policy --role-name bbb-mcp-deploy \
    --policy-document file:///tmp/deploy-trust-transition.json
  echo "Deploy role trust: aws + aws-gated (transition); policy unchanged"
elif [ "${DEPLOY_ROLE_STAGE}" = "final" ]; then
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
else
  echo "DEPLOY_ROLE_STAGE must be final or transition; deploy role NOT changed"
fi

# ---- 3c. Corpus-sync role (ungated docs publisher) ---------
# Assumed by .github/workflows/corpus-sync.yml on every push to
# main that touches a corpus doc, with no environment gate: the
# merge itself was the editorial decision on that markdown, so a
# second approval would re-review nothing. What makes ungated
# acceptable is how little the role holds -- writes to the corpus
# bucket plus starting/polling ingestion jobs, nothing else. No
# Lambda, no IAM, no Terraform state, no API Gateway.
#
# Created HERE by a human, like the deploy and update roles, and
# deliberately named outside the bbb-mcp-server-*/bbb-mcp-kb-*
# patterns the deploy policy's IAM statements are scoped to, so the
# pipeline can neither create this role nor widen it.
# tests/infra-boundaries.test.ts pins its grants and checks that
# separation on every CI run.
#
# Known limit of the trust policy, worth understanding before adding
# workflows to this repo: the subject below pins the main REF, not an
# event or a workflow file, so any job here running on main that asks
# for an OIDC token without an environment can assume this role. AWS
# accepts conditions on aud/azp/amr/sub only, so it cannot match
# GitHub's job_workflow_ref claim directly -- and a condition on a
# claim AWS does not populate evaluates false, which denies every run
# rather than narrowing one. So the containment is the role's own
# narrowness (it can republish docs and nothing else) plus a test
# asserting which workflows may request a token at all.
#
# Two ways to narrow further if that stops being enough:
#
#   * Give this role its own GitHub environment with NO required
#     reviewers and its branches limited to main, then pin the subject
#     to ":environment:<name>" (the pattern the update role, 3e, uses).
#     Cheap, and keeps the role ungated, but it narrows to jobs that OPT
#     IN -- any workflow naming that environment still gets the subject.
#   * Customise the repo's subject claim to include job_workflow_ref
#     and pin the whole string. This does pin one workflow file, but
#     the customisation is repo-WIDE: it rewrites the subject for every
#     workflow, so the deploy and update roles' trust policies have to
#     change in the same sitting or deploys stop authenticating. GitHub
#     also documents creating the matching cloud-side condition first.
#     How that segment renders under the immutable subject format this
#     repo uses is not documented -- confirm with an OIDC debugger run
#     before pasting a policy that depends on it.
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

# ---- 3e. Update role (unattended, code-only deploys) -------
# (3e runs before 3d: the backstop's action targets this role, so
# it must exist first. The letters record the order the sections
# were added, not the order they run.)
#
# Assumed by the deploy workflow's unattended job in the `aws`
# GitHub environment, which has NO required reviewer and is limited
# to main. What makes that acceptable is what this role cannot do:
#
#   * Writes: the Lambda's CODE only (lambda:UpdateFunctionCode on
#     exactly bbb-mcp-server), tags on the Lambda, corpus bucket,
#     vector store and knowledge base, corpus objects, starting an
#     ingestion, and Terraform state. Nothing else.
#   * No IAM write and no iam:PassRole, so it cannot create or
#     reshape a role or point the Lambda at a different one.
#   * No lambda:UpdateFunctionConfiguration, so the timeout, memory,
#     environment and execution role stay what a gated run set.
#   * No lambda:InvokeFunction, so it cannot call the server around
#     the API key.
#   * No API Gateway write, and no write to the backstop (3d), with
#     the same explicit Denies the deploy role carries.
#
# Reads are wildcards (Get*/List*/Describe*) on stack resources so a
# Terraform provider bump that adds a refresh call does not break the
# unattended path. One read matters: apigateway:GET returns the API
# keys' values, so this role can read them (and so spend their
# monthly quotas, which it cannot change).
#
# Anything the plan needs beyond these grants fails with
# AccessDenied, which the workflow routes to the gated deploy role.
# Named outside every pattern the deploy policy can write, like the
# corpus-sync role; tests/infra-boundaries.test.ts pins the exact
# grants below and that separation.
cat > /tmp/update-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_URL}:aud": "sts.amazonaws.com",
        "${OIDC_URL}:sub": "${UPDATE_SUB}"
      }
    }
  }]
}
EOF

cat > /tmp/update-policy.json <<EOF
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
      "Sid": "LambdaCodeOnly",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode"],
      "Resource": "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:bbb-mcp-server"
    },
    {
      "Sid": "LambdaTags",
      "Effect": "Allow",
      "Action": ["lambda:TagResource", "lambda:UntagResource"],
      "Resource": "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:bbb-mcp-server"
    },
    {
      "Sid": "LambdaRead",
      "Effect": "Allow",
      "Action": ["lambda:Get*", "lambda:List*"],
      "Resource": "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:bbb-mcp-*"
    },
    {
      "Sid": "CorpusObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}/*"
    },
    {
      "Sid": "CorpusTags",
      "Effect": "Allow",
      "Action": ["s3:PutBucketTagging"],
      "Resource": "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}"
    },
    {
      "Sid": "CorpusRead",
      "Effect": "Allow",
      "Action": ["s3:Get*", "s3:List*"],
      "Resource": [
        "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}",
        "arn:aws:s3:::bbb-mcp-corpus-${ACCOUNT_ID}/*"
      ]
    },
    {
      "Sid": "VectorStoreTags",
      "Effect": "Allow",
      "Action": ["s3vectors:TagResource", "s3vectors:UntagResource"],
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*/index/*"
      ]
    },
    {
      "Sid": "VectorStoreRead",
      "Effect": "Allow",
      "Action": ["s3vectors:Get*", "s3vectors:List*"],
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/bbb-mcp-*/index/*"
      ]
    },
    {
      "Sid": "KnowledgeBaseIngest",
      "Effect": "Allow",
      "Action": ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob"],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    },
    {
      "Sid": "KnowledgeBaseTags",
      "Effect": "Allow",
      "Action": ["bedrock:TagResource", "bedrock:UntagResource"],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    },
    {
      "Sid": "KnowledgeBaseRead",
      "Effect": "Allow",
      "Action": ["bedrock:Get*", "bedrock:List*"],
      "Resource": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"
    },
    {
      "Sid": "LogGroupRead",
      "Effect": "Allow",
      "Action": ["logs:Describe*", "logs:List*"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*"
    },
    {
      "Sid": "ApiGatewayRead",
      "Effect": "Allow",
      "Action": ["apigateway:GET"],
      "Resource": "arn:aws:apigateway:${REGION}::/*"
    },
    {
      "Sid": "StackRoleRead",
      "Effect": "Allow",
      "Action": ["iam:Get*", "iam:List*"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-*",
        "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-*"
      ]
    },
    {
      "Sid": "BackstopRead",
      "Effect": "Allow",
      "Action": ["budgets:ViewBudget", "budgets:DescribeBudgetAction*"],
      "Resource": "arn:aws:budgets::${ACCOUNT_ID}:budget/bbb-backstop-*"
    },
    {
      "Sid": "DenyBackstopWrites",
      "Effect": "Deny",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
        "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
        "iam:TagRole", "iam:UntagRole", "iam:PassRole",
        "iam:CreatePolicy", "iam:DeletePolicy",
        "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy", "iam:UntagPolicy",
        "budgets:ModifyBudget",
        "budgets:CreateBudgetAction", "budgets:UpdateBudgetAction",
        "budgets:DeleteBudgetAction", "budgets:ExecuteBudgetAction",
        "budgets:TagResource", "budgets:UntagResource"
      ],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-backstop-*",
        "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-*",
        "arn:aws:budgets::${ACCOUNT_ID}:budget/bbb-backstop-*"
      ]
    },
    {
      "Sid": "DenyBackstopDetach",
      "Effect": "Deny",
      "Action": ["iam:DetachRolePolicy"],
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "iam:PolicyARN": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-*"
        }
      }
    }
  ]
}
EOF

if aws iam get-role --role-name bbb-mcp-update >/dev/null 2>&1; then
  echo "Update role already exists; refreshing trust + policy"
  aws iam update-assume-role-policy --role-name bbb-mcp-update \
    --policy-document file:///tmp/update-trust.json
else
  aws iam create-role --role-name bbb-mcp-update \
    --assume-role-policy-document file:///tmp/update-trust.json \
    --description "GitHub Actions OIDC role for unattended BBB MCP code-only deploys" \
    --max-session-duration 3600 \
    --tags Key=project,Value=bbb-mcp >/dev/null
  echo "Update role created"
fi
aws iam put-role-policy --role-name bbb-mcp-update \
  --policy-name bbb-mcp-update-policy \
  --policy-document file:///tmp/update-policy.json
echo "Update policy attached"

# ---- 3d. Cost backstop (human-owned) -----------------------
# A monthly budget on the account's actual costs whose action, at
# 100%, AUTOMATICALLY attaches a deny policy to every role that can
# spend: the server and knowledge-base roles (Terraform) and the
# update and corpus-sync roles (this script). The deny covers
# Bedrock, CloudWatch Logs ingestion and S3 writes. Billing data
# lags by hours, so the gateway quota, the per-request caps and the
# Bedrock rate quotas bound spending inside that window; this bounds
# the month.
#
# Owned HERE, by a human, and named bbb-backstop-* so it sits outside
# every pattern either deploy role can write. Both carry explicit
# Denies on writing it and on detaching its deny policy from any
# role, so no run of the pipeline, gated or not, can disarm it.
# Reads stay allowed, for the deploy workflow's smoke test.
#
# Nothing un-denies itself: once fired, the deny stays attached across
# month rollover until a human resets it ("If the backstop ever
# fires", below). While it is attached, gated deploys still work (the
# deploy role is not a target), but unattended deploys fail at their
# Terraform state write (s3:PutObject).
#
# Runs only once all four target roles exist. On a fresh account the
# two Terraform roles appear at the stack's first apply, so this
# section skips until Step 3 is re-pasted after that apply.
BACKSTOP_ROLES="bbb-mcp-server-exec bbb-mcp-kb-role bbb-mcp-update bbb-mcp-corpus-sync"

cat > /tmp/backstop-deny.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenySpending",
    "Effect": "Deny",
    "Action": ["bedrock:*", "logs:PutLogEvents", "s3:PutObject"],
    "Resource": "*"
  }]
}
EOF

cat > /tmp/backstop-action-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "budgets.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" }
    }
  }]
}
EOF

# Attach and detach are pinned to the one deny policy via
# iam:PolicyARN, so this role can never be steered into attaching
# anything else to the target roles. Capped by bbb-mcp-boundary-iam
# (3a), which allows exactly these four actions on these four roles.
cat > /tmp/backstop-action-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AttachDenyToTargetRoles",
      "Effect": "Allow",
      "Action": ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-exec",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-role",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-update",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-corpus-sync"
      ],
      "Condition": {
        "ArnEquals": {
          "iam:PolicyARN": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-deny"
        }
      }
    },
    {
      "Sid": "InspectTargetRoles",
      "Effect": "Allow",
      "Action": ["iam:GetRole", "iam:ListAttachedRolePolicies"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-exec",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-kb-role",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-update",
        "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-corpus-sync"
      ]
    }
  ]
}
EOF

cat > /tmp/backstop-budget.json <<EOF
{
  "BudgetName": "bbb-backstop-monthly",
  "BudgetLimit": { "Amount": "${BACKSTOP_LIMIT_USD}", "Unit": "USD" },
  "BudgetType": "COST",
  "TimeUnit": "MONTHLY"
}
EOF

cat > /tmp/backstop-action-definition.json <<EOF
{
  "IamActionDefinition": {
    "PolicyArn": "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-deny",
    "Roles": [
      "bbb-mcp-server-exec",
      "bbb-mcp-kb-role",
      "bbb-mcp-update",
      "bbb-mcp-corpus-sync"
    ]
  }
}
EOF

MISSING_ROLES=""
for r in ${BACKSTOP_ROLES}; do
  aws iam get-role --role-name "$r" >/dev/null 2>&1 || MISSING_ROLES="${MISSING_ROLES} $r"
done

if [ -n "${MISSING_ROLES}" ]; then
  echo "Backstop SKIPPED: target role(s) missing:${MISSING_ROLES}"
  echo "  Re-paste Step 3 after the stack's first apply to arm it."
else
  put_managed_policy bbb-backstop-deny /tmp/backstop-deny.json \
    "Attached by the BBB MCP cost backstop to stop spending"

  if aws iam get-role --role-name bbb-backstop-action >/dev/null 2>&1; then
    echo "Backstop role already exists; refreshing trust, boundary + policy"
    aws iam update-assume-role-policy --role-name bbb-backstop-action \
      --policy-document file:///tmp/backstop-action-trust.json
    aws iam put-role-permissions-boundary --role-name bbb-backstop-action \
      --permissions-boundary "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-iam"
  else
    aws iam create-role --role-name bbb-backstop-action \
      --assume-role-policy-document file:///tmp/backstop-action-trust.json \
      --permissions-boundary "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-boundary-iam" \
      --description "Execution role for the BBB MCP cost-backstop budget action" \
      --tags Key=project,Value=bbb-mcp >/dev/null
    echo "Backstop role created"
    sleep 10  # let IAM propagate before Budgets validates the role
  fi
  aws iam put-role-policy --role-name bbb-backstop-action \
    --policy-name bbb-backstop-action-policy \
    --policy-document file:///tmp/backstop-action-policy.json

  if aws budgets describe-budget --account-id "${ACCOUNT_ID}" \
      --budget-name bbb-backstop-monthly --region us-east-1 >/dev/null 2>&1; then
    echo "Backstop budget exists; refreshing its limit"
    aws budgets update-budget --account-id "${ACCOUNT_ID}" \
      --new-budget file:///tmp/backstop-budget.json --region us-east-1
  else
    aws budgets create-budget --account-id "${ACCOUNT_ID}" \
      --budget file:///tmp/backstop-budget.json --region us-east-1
    echo "Backstop budget created (${BACKSTOP_LIMIT_USD} USD/month)"
  fi

  ACTION_ID=$(aws budgets describe-budget-actions-for-budget \
    --account-id "${ACCOUNT_ID}" --budget-name bbb-backstop-monthly \
    --region us-east-1 --query 'Actions[0].ActionId' --output text)
  if [ -n "${ACTION_ID}" ] && [ "${ACTION_ID}" != "None" ]; then
    echo "Backstop action exists; refreshing its targets and subscriber"
    aws budgets update-budget-action --account-id "${ACCOUNT_ID}" \
      --budget-name bbb-backstop-monthly --action-id "${ACTION_ID}" \
      --definition file:///tmp/backstop-action-definition.json \
      --subscribers "SubscriptionType=EMAIL,Address=${ALERT_EMAIL}" \
      --region us-east-1 >/dev/null \
      || echo "  Could not update it (fired? see 'If the backstop ever fires')"
  else
    aws budgets create-budget-action --account-id "${ACCOUNT_ID}" \
      --budget-name bbb-backstop-monthly \
      --notification-type ACTUAL \
      --action-type APPLY_IAM_POLICY \
      --action-threshold ActionThresholdValue=100,ActionThresholdType=PERCENTAGE \
      --definition file:///tmp/backstop-action-definition.json \
      --execution-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/bbb-backstop-action" \
      --approval-model AUTOMATIC \
      --subscribers "SubscriptionType=EMAIL,Address=${ALERT_EMAIL}" \
      --region us-east-1 >/dev/null
    echo "Backstop action created"
  fi
  aws budgets describe-budget-actions-for-budget \
    --account-id "${ACCOUNT_ID}" --budget-name bbb-backstop-monthly \
    --region us-east-1 --query 'Actions[].[ActionId,Status]' --output text
  echo "  (STANDBY = armed)"
fi

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

rm -f /tmp/trust.json /tmp/deploy-trust-transition.json /tmp/policy.json \
      /tmp/budget.json /tmp/budget-notify.json \
      /tmp/boundary-workload.json /tmp/boundary-iam.json \
      /tmp/corpus-trust.json /tmp/corpus-policy.json \
      /tmp/update-trust.json /tmp/update-policy.json \
      /tmp/backstop-deny.json /tmp/backstop-action-trust.json \
      /tmp/backstop-action-policy.json /tmp/backstop-budget.json \
      /tmp/backstop-action-definition.json

echo
echo "=========================================================="
echo "Bootstrap complete (deploy role stage: ${DEPLOY_ROLE_STAGE})."
echo
echo "  Trust policies pinned to OIDC subjects:"
echo "    deploy (3b):      ${DEPLOY_SUB}"
echo "    update (3e):      ${UPDATE_SUB}"
echo "    corpus-sync (3c): ${CORPUS_SYNC_SUB}"
echo "  (verify the shared prefix matches the repo's OIDC settings preview)"
echo
echo "Now add these in GitHub (Step 4):"
echo
echo "  Repository variables (Settings > Secrets and variables"
echo "  > Actions > Variables tab > New repository variable):"
echo
echo "    AWS_UPDATE_ROLE_ARN = arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-update"
echo "    AWS_ROLE_ARN        = arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-deploy"
echo "    AWS_REGION          = ${REGION}"
echo "    TF_STATE_BUCKET     = ${STATE_BUCKET}"
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

**A note on what the trust policies pin.** With the immutable subject claim
enabled (Step 3.1), the three GitHub Actions roles trust a GitHub identity
that embeds the account's and repository's permanent numeric IDs, not just
their names. A recycled or squatted name can therefore never mint a
matching token, even if the account or repo were deleted and re-registered
by someone else. One operational consequence: renaming or transferring the
repository changes the subject's name portion, so deploys and corpus syncs
would stop authenticating (a safe, fail-closed outcome) until the trust
policies are updated; re-running the Step 3 script with an updated
`GITHUB_REPO_SUB` refreshes all three in place.


## Step 4 -- GitHub environments and variables (~10 min)

All of this is in the repo:
<https://github.com/jtzingsheim1/brisbane-bowser-beater/settings>.

1. **Create the unattended environment.** Settings, **Environments**, **New
   environment**, name it exactly `aws`.
   - Leave **Required reviewers** unticked. Runs in this environment get
     the update role (section 3e) and proceed without approval.
   - Under **Deployment branches and tags**, choose **Selected branches and
     tags** and add a rule for `main` (no tag rule). Only workflow runs
     from `main` can use the environment.
2. **Create the gated environment.** **New environment** again, name it
   exactly `aws-gated`.
   - Tick **Required reviewers** and add yourself.
   - Untick **Allow administrators to bypass configured protection
     rules**, so no account, yours included, can skip the approval.
   - Under **Deployment branches and tags**, choose **Selected branches and
     tags** and add a rule for `main`.
   - **Save protection rules**. Every gated run will pause until you
     approve it in the Actions UI (or on GitHub Mobile).

   > **The `aws-gated` reviewer is the human-approval gate.** AWS trusts
   > any workflow run carrying the `environment:aws-gated` identity with
   > the deploy role, which can change IAM, API Gateway, the Lambda's
   > configuration and anything else in the stack; that a human approves
   > each such run comes entirely from the reviewer rule set here, not
   > from AWS. Never remove that reviewer, and never re-tick the admin
   > bypass. The `aws` environment has no reviewer on purpose: its role
   > can only replace the Lambda's code, retag stack resources, republish
   > the docs corpus and write Terraform state, and anything more fails
   > with AccessDenied and waits for `aws-gated`. Both environments must
   > stay limited to `main`. To stop unattended deploys at once, add a
   > reviewer to `aws`: every run then waits for an approval.
3. **Protect `main`.** Settings, **Branches** (or **Rules**), a rule for
   `main`: require a pull request before merging (0 approvals, so a
   single maintainer and the weekly dependency session can still merge),
   and do not allow administrators to bypass it. Both environments trust
   whatever is on `main`, so this is what keeps a direct push from
   deploying.
4. **Add the repository variables.** Settings, **Secrets and variables**,
   **Actions**, **Variables** tab, **New repository variable**. Create the
   four variables exactly as printed by the CloudShell script:
   - `AWS_UPDATE_ROLE_ARN`
   - `AWS_ROLE_ARN`
   - `AWS_REGION`
   - `TF_STATE_BUCKET`

   Then two more, so the deployed server knows where to read its data.
   Both values already exist in the Vercel project's environment variables
   (Vercel dashboard, the BBB project, Settings, Environment Variables),
   or in your local `.env.local`:
   - `SUPABASE_URL` (same value as `NEXT_PUBLIC_SUPABASE_URL`)
   - `SUPABASE_ANON_KEY` (same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY`)

   Optionally `BBB_STALENESS_MINUTES`, the same value as the Vercel variable
   of that name, so the server's staleness gate matches the website's.
   Unset, both default to 60.

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
   sensitive. A role ARN is not a credential (the deploy role needs a
   GitHub OIDC token from an approved run of this repo's `aws-gated`
   environment, the update role one from this repo's `aws` environment,
   which only `main` can use, and the corpus-sync role one from a job on
   this repo's `main`), and the Supabase URL and anon key are the
   publishable (low-privilege) tier, with Postgres grants/RLS limiting the
   anon role to aggregate read paths only. The backstop's alert email is
   not a GitHub variable: it lives only in the Step 3 script.

That's it. No AWS keys were created, and none will be. The first deploy
creates the whole stack, which the update role cannot do, so it waits for
your approval on `aws-gated`; approving it is what releases short-lived
deploy-role credentials to that single run. After that first apply,
re-paste the Step 3 script to arm the cost backstop (section 3d) and to
print the two knowledge-base ids for the corpus-sync variables.

---

## Update for the docs Q&A (RAG) stack (2026-08, ~15 min once)

The RAG extension (see `docs/mcp-rag-design.md`) added Bedrock, S3
Vectors, a corpus bucket, and a cost-backstop budget action to the
Terraform stack. In 2026-11 the backstop moved out of Terraform into the
human-owned section 3d (see "Update for auto-deploy"); the steps below
are the ones the 2026-08 deploy needed, updated where that move changed
them. Before its first deploy, these one-time things need a human:

1. **Refresh the deploy role.** Re-run the Step 3 CloudShell script above
   (it is idempotent; the policy it writes includes the RAG
   permissions).
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
3. **The alert email.** In 2026-08 this step added an `ALERT_EMAIL`
   repository variable, the Terraform budget action's subscriber. Since
   2026-11 the address is `ALERT_EMAIL` at the top of the Step 3 script
   and no GitHub variable is involved.

Two budget notes:

- The Step 3 **zero-spend budget will alert every month** once real
  (tiny) Bedrock spend begins. That is it working as designed; keep it as
  a heartbeat, or delete/raise it in the console when it becomes noise.
- After the backstop is armed (section 3d), verify in **AWS Budgets** that
  the `bbb-backstop-monthly` budget's action shows **Standby**: that is
  the armed state of the layer that attaches `bbb-backstop-deny` to the
  four roles that can spend at 100% of budget. The Step 3 script prints
  the action's status at the end of section 3d.

**If the backstop ever fires** (docs tools start returning errors,
unattended deploys fail at their state write, and the budget emails you):
the deny policy stays attached across month rollover by design --
nothing un-denies itself. Neither deploy role can detach it, so a gated
deploy does not clear it either. To restore service after deciding the
spend was acceptable, detach it from every target role in CloudShell:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
for r in bbb-mcp-server-exec bbb-mcp-kb-role bbb-mcp-update bbb-mcp-corpus-sync; do
  aws iam detach-role-policy --role-name "$r" \
    --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-deny" \
    2>/dev/null && echo "Detached from $r"
done
```

then in the Budgets console reset the `bbb-backstop-monthly` action and
confirm it shows **Standby** again (or re-paste Step 3, which prints the
status). If the stack is being torn down instead, the same detach is
step 1 of "Decommissioning": `terraform destroy` cannot detach it.

---

## Update for the permissions boundaries (2026-08, ~5 min once)

**Already done on the live account** (2026-08-23, deploy run 8). The steps
stay here because rebuilding the account from scratch needs them, and
because re-running the Step 3 paste is how any future boundary change is
applied.

Since 2026-11 ("Update for auto-deploy") the budget-action role is
human-owned (`bbb-backstop-action`, section 3d), so Terraform creates two
roles rather than the three below, `bbb-mcp-boundary-iam` caps only that
hand-made role, and the deploy role can no longer create a role under it.
The workload boundary's Bedrock model calls are limited to the two models
the stack uses. The reasoning below is unchanged.

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
and those actions target the server role itself (since 2026-11, the
knowledge-base, update and corpus-sync roles too). A single shared
ceiling would therefore let a rewritten server policy detach the cost
backstop's deny policy, which denies spending actions, not IAM, and so
cannot protect itself. So:

- `bbb-mcp-boundary-workload` (server + knowledge-base roles): CloudWatch
  Logs writes, Bedrock retrieve/generate, model calls and
  inference-profile lookup on the stack's two models only, corpus-bucket
  reads, and S3 Vectors operations. **No IAM actions at all.**
- `bbb-mcp-boundary-iam` (the backstop's action role only): exactly the
  four IAM calls that role makes to attach the deny policy when the
  backstop fires, on exactly the roles it targets.

The deploy policy pins the workload boundary in both the `iam:CreateRole`
condition and the `iam:PutRolePermissionsBoundary` grant (in 2026-08 it
pinned each of the two boundaries to its own role-name pattern), so a
server or knowledge-base role can never be given the IAM ceiling. Widening either is a deliberate act that belongs in the same
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

The two boundary documents in section 3a and the role policies they cap
(in `infra/*.tf`, and the backstop role's in section 3d) are separate
artifacts that can drift apart in either
direction, so CI compares them (`tests/infra-boundaries.test.ts`): each
boundary must allow exactly the union of the actions granted to the roles
it caps. A role policy that outgrew its boundary would otherwise fail only
as a runtime `AccessDenied`, and a boundary that outgrew its roles would
not fail at all. The same test checks the pinning clauses in the deploy
policy: no role creation or re-capping without an
`iam:PermissionsBoundary` condition, each role name eligible for exactly
one ceiling, the Deny statements intact, and no path by which the deploy
role could rewrite its own permissions.

---

## Update for the ungated corpus sync (2026-08, ~5 min once)

**Already done on the live account** (2026-08-24: Step 3 re-pasted, the four
repository variables added, and the corpus sync verified green end to end --
files synced and the ingestion job reached COMPLETE). The steps stay here
because rebuilding the account from scratch needs them.

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
   (listed in Step 4.4): `AWS_CORPUS_SYNC_ROLE_ARN`, `MCP_KB_ID`,
   `MCP_DATA_SOURCE_ID`, `MCP_CORPUS_BUCKET`.

No environment gate for this workflow, on purpose: the merge that landed a
doc was the editorial decision, and the role is too narrow to touch the
deployed stack (section 3c's comment carries the reasoning;
`tests/infra-boundaries.test.ts` and `tests/corpus-sync-workflow.test.ts`
hold the role and workflow to it). The deploy workflow also syncs the
corpus after each apply, so infra-driven corpus changes (a rebuilt
knowledge base, say) do not wait for the next doc merge.

---

## Update for auto-deploy (2026-11, ~30 min once)

Moves the MCP deploy from "every run waits for an approval" to two roles:
code-only changes deploy unattended under the update role (section 3e,
environment `aws`), and everything else waits for one approval under the
deploy role (section 3b, environment `aws-gated`). The cost backstop moves
out of Terraform into the human-owned section 3d, so neither role can
change it. The design and its reasoning are in
`docs/mcp-auto-deploy-design.md`; the role comments in Step 3 carry each
role's bounds.

The live account stays protected throughout: additive first, then the
merge (which makes Terraform forget the old backstop without deleting
it), then the narrowing. Do the steps in this order.

1. **Paste A: CloudShell, BEFORE merging** (additive, idempotent). Edit
   the top of the Step 3 script: set `ALERT_EMAIL`, and set
   `DEPLOY_ROLE_STAGE="transition"`. Paste the whole script. On this run
   it:
   - creates the update role `bbb-mcp-update` (3e);
   - arms the new `bbb-backstop-*` resources (3d), a second backstop
     alongside the old Terraform-managed `bbb-mcp-monthly` one;
   - narrows the workload boundary to the two models, and widens
     `bbb-mcp-boundary-iam` to the four roles the new backstop targets
     (3a);
   - adds the `aws-gated` subject to the deploy role's trust, keeping the
     `aws` one, and leaves the deploy role's POLICY as it was (3b,
     transition branch).

   Check the output says "transition; policy unchanged" for the deploy
   role and shows the backstop action in `STANDBY`. Then ask the docs Q&A
   tool one question through any MCP client using the private key: an
   access error now means the boundary's model ARNs do not match what the
   server calls, and the fix is to correct section 3a and re-paste before
   going further.

   Do not paste with `DEPLOY_ROLE_STAGE="final"` yet. The narrowed deploy
   policy cannot read the old backstop, and the merge's gated run has to
   read it in order to forget it.
2. **Console and GitHub, still before merging.**
   - **Read the two Bedrock rate quotas.** In CloudShell:

     ```bash
     aws service-quotas list-service-quotas --service-code bedrock \
       --query "Quotas[?contains(QuotaName, 'Haiku 4.5') || contains(QuotaName, 'Titan Text Embeddings V2')].[QuotaName,Value]" \
       --output table
     ```

     Record the on-demand requests-per-minute and tokens-per-minute
     values for both models, and the worst-case monthly spend they allow.
     Lower them through Service Quotas only if that figure exceeds the
     backstop's monthly limit.
   - **Create the `aws-gated` environment** exactly as Step 4.2
     describes (you as required reviewer, admin bypass unticked, `main`
     only). Leave `aws` as it is for now: it keeps its reviewer until
     step 5.
   - **Add the `AWS_UPDATE_ROLE_ARN` repository variable**
     (`arn:aws:iam::<account-id>:role/bbb-mcp-update`, printed by the
     script).
   - **Protect `main`** as Step 4.3 describes.
3. **Merge.** `aws` still has its reviewer, so the push run first asks
   you to approve the unattended job. Its plan cannot read the old
   backstop, so it routes to the gated job, which asks for a second
   approval on `aws-gated`. That apply forgets the five old backstop
   resources (the `removed` blocks in `infra/rag.tf`) without deleting
   them. Approve both; check the gated apply reports them as forgotten,
   not destroyed.
4. **Paste B: CloudShell, after that gated apply succeeds.** First delete
   the old backstop, in this order (each step skips what is already
   gone):

   ```bash
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   OLD_DENY="arn:aws:iam::${ACCOUNT_ID}:policy/bbb-mcp-bedrock-deny"

   # 1. Detach the old deny policy wherever it is attached (only if it
   #    ever fired).
   if aws iam get-policy --policy-arn "${OLD_DENY}" >/dev/null 2>&1; then
     for r in $(aws iam list-entities-for-policy --policy-arn "${OLD_DENY}" \
         --query 'PolicyRoles[].RoleName' --output text); do
       aws iam detach-role-policy --role-name "$r" --policy-arn "${OLD_DENY}"
       echo "Detached old deny from $r"
     done
   fi

   # 2. The old budget action, then the old budget.
   if aws budgets describe-budget --account-id "${ACCOUNT_ID}" \
       --budget-name bbb-mcp-monthly --region us-east-1 >/dev/null 2>&1; then
     for a in $(aws budgets describe-budget-actions-for-budget \
         --account-id "${ACCOUNT_ID}" --budget-name bbb-mcp-monthly \
         --region us-east-1 --query 'Actions[].ActionId' --output text); do
       aws budgets delete-budget-action --account-id "${ACCOUNT_ID}" \
         --budget-name bbb-mcp-monthly --action-id "$a" \
         --region us-east-1 >/dev/null
       echo "Deleted old budget action $a"
     done
     aws budgets delete-budget --account-id "${ACCOUNT_ID}" \
       --budget-name bbb-mcp-monthly --region us-east-1
     echo "Deleted old budget bbb-mcp-monthly"
   fi

   # 3. The old action role's inline policy, then the role.
   if aws iam get-role --role-name bbb-mcp-budgets-action >/dev/null 2>&1; then
     aws iam delete-role-policy --role-name bbb-mcp-budgets-action \
       --policy-name bbb-mcp-budgets-policy 2>/dev/null
     aws iam delete-role --role-name bbb-mcp-budgets-action
     echo "Deleted old role bbb-mcp-budgets-action"
   fi

   # 4. The old deny policy (non-default versions first).
   if aws iam get-policy --policy-arn "${OLD_DENY}" >/dev/null 2>&1; then
     for v in $(aws iam list-policy-versions --policy-arn "${OLD_DENY}" \
         --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
       aws iam delete-policy-version --policy-arn "${OLD_DENY}" --version-id "$v"
     done
     aws iam delete-policy --policy-arn "${OLD_DENY}"
     echo "Deleted old policy bbb-mcp-bedrock-deny"
   fi
   ```

   Then set `DEPLOY_ROLE_STAGE="final"` at the top of the Step 3 script
   and paste it again. On this run it replaces the deploy role's policy
   with the narrowed one plus the backstop Denies, and rewrites its trust
   to the `aws-gated` subject only. Check the output says "Deploy policy
   attached".
5. **GitHub.** Remove the required reviewer from the `aws` environment
   (keep its `main`-only branch rule), and delete the `ALERT_EMAIL`
   repository variable, which nothing reads any more.
6. **Verify.** Dispatch the deploy workflow with `apply` on `main`. It
   should run unattended on `aws` to "no changes" and pass its smoke
   test, without asking for an approval. Confirm the deploy role trusts
   only `aws-gated`:

   ```bash
   aws iam get-role --role-name bbb-mcp-deploy \
     --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition' --output json
   ```

   Then record the dated events in `PLAN.md`.

**Rollback.** Adding a reviewer back to `aws` stops unattended deploys at
once: every run then waits for an approval. Never move the backstop back
into Terraform without `import` blocks, or Terraform will try to create
resources that already exist.

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
replace it), then run the deploy workflow. Recreating a key is an API
Gateway change, which the update role cannot make, so that run waits for
one approval on `aws-gated`. Then re-run the matching command above.

Both deploy roles can read the key values (`apigateway:GET`, which
Terraform's refresh needs), which is why the deploy workflow never prints
or uploads the plan. A leaked key spends that key's monthly quota and
nothing more; rotate it as above.

## Decommissioning (for reference, not now)

The deployed stack is one Terraform root module; the hand-made resources
around it are not, and two of them must go for the exit to stick. Teardown,
in this order:

1. **Detach the backstop deny, in CloudShell.** Only needed if the
   backstop has fired, but harmless otherwise. Neither deploy role may
   detach `bbb-backstop-deny`, so a destroy would otherwise fail when it
   tries to delete a role the deny is attached to. Run the detach loop in
   "If the backstop ever fires" above.
2. **Destroy the stack.** Run the deploy workflow in destroy mode, which
   always runs on the gated path (one approval on `aws-gated`). It
   removes the Lambda, API, keys, logs, the knowledge base, the vector
   store and the corpus bucket.
3. **Delete both deploy roles, in CloudShell: required.** A later merge to
   `main` would otherwise trigger the deploy workflow and, with one
   approval, rebuild the stack, and licence cl 4.6 bars using the
   Licensed Data or derived products after termination. Delete each
   role's inline policy, then the role:

   ```bash
   for r in bbb-mcp-update bbb-mcp-deploy; do
     aws iam delete-role-policy --role-name "$r" --policy-name "$r-policy"
     aws iam delete-role --role-name "$r"
   done
   ```

   Also disable the deploy workflow (Actions, the workflow, **Disable
   workflow**), so later merges do not start runs that fail at
   authentication and open issues.
4. **Delete the backstop, in CloudShell**, after the stack is gone: the
   budget action, then the budget, then the action role's inline policy
   and the role, then the deny policy.

   ```bash
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   for a in $(aws budgets describe-budget-actions-for-budget \
       --account-id "${ACCOUNT_ID}" --budget-name bbb-backstop-monthly \
       --region us-east-1 --query 'Actions[].ActionId' --output text); do
     aws budgets delete-budget-action --account-id "${ACCOUNT_ID}" \
       --budget-name bbb-backstop-monthly --action-id "$a" --region us-east-1
   done
   aws budgets delete-budget --account-id "${ACCOUNT_ID}" \
     --budget-name bbb-backstop-monthly --region us-east-1
   aws iam delete-role-policy --role-name bbb-backstop-action \
     --policy-name bbb-backstop-action-policy
   aws iam delete-role --role-name bbb-backstop-action
   DENY="arn:aws:iam::${ACCOUNT_ID}:policy/bbb-backstop-deny"
   for v in $(aws iam list-policy-versions --policy-arn "${DENY}" \
       --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
     aws iam delete-policy-version --policy-arn "${DENY}" --version-id "$v"
   done
   aws iam delete-policy --policy-arn "${DENY}"
   ```
5. **Optionally, the rest, in CloudShell:** the corpus-sync role (it keeps
   trusting GitHub OIDC, with a grant on the deterministically-named
   corpus bucket that would go live again if the stack were ever
   rebuilt), the OIDC provider, the state bucket, the zero-spend budget,
   and the two `bbb-mcp-boundary-*` policies (the reverse of Step 3).
   Delete the boundary policies LAST, and only as part of a full
   teardown: the backstop role is capped by one of them, and a rebuild
   needs them back (re-running Step 3 recreates them, with the roles).
6. The account itself can then be closed from the console if it is no
   longer wanted.
