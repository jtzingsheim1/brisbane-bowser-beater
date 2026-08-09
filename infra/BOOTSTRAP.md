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

## Step 3 -- CloudShell bootstrap (~5 min, one paste)

1. In the console's top-right region selector, choose
   **Asia Pacific (Sydney) ap-southeast-2**.
2. Open **CloudShell** (the terminal icon in the top toolbar, or search
   "CloudShell").
3. **Edit the two variables at the top** of the script below (your alert
   email; the repo is already correct), then paste the whole thing into
   CloudShell and press Enter.

The script is idempotent: if a resource already exists it says so and moves
on, so it is safe to re-run if anything is interrupted.

```bash
# ============================================================
# BBB MCP one-time bootstrap. Region: ap-southeast-2 (Sydney).
# EDIT THESE TWO LINES, then paste the whole script.
# ============================================================
ALERT_EMAIL="you@example.com"                     # billing alert email
GITHUB_REPO="jtzingsheim1/brisbane-bowser-beater" # owner/repo
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

# ---- 3. Deploy role (assumed by GitHub Actions via OIDC) ---
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
        "${OIDC_URL}:sub": "repo:${GITHUB_REPO}:environment:aws"
      }
    }
  }]
}
EOF

# Least-privilege deploy permissions: only what Terraform needs
# to manage the bbb-mcp stack. The IAM actions are scoped to
# bbb-mcp-SERVER-* (the Lambda execution role Terraform creates,
# named bbb-mcp-server-exec) -- deliberately NOT bbb-mcp-* , which
# would also match this deploy role (bbb-mcp-deploy) and let an
# assumed session rewrite its own policy/trust to escalate to
# admin. An explicit Deny on the deploy role's own ARN makes that
# impossible even if the pattern is ever loosened. API Gateway
# does not support name-scoped ARNs, so it is scoped to this
# region and account (which contains nothing else).
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
      "Sid": "LambdaExecRole",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole",
        "iam:TagRole", "iam:UntagRole",
        "iam:UpdateRole", "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/bbb-mcp-server-*"
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
echo "Bootstrap complete. Now add these in GitHub (Step 4):"
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

**A note on what the trust policy pins.** The deploy role trusts the GitHub
identity string `repo:jtzingsheim1/brisbane-bowser-beater:environment:aws`,
which pins by *name*. Names can in principle be recycled: if the GitHub
account or repository were ever deleted or renamed and someone re-registered
the same names, they could mint matching tokens. Two implications:

- Do not delete or rename the GitHub account or repository while this AWS
  account exists without updating (or removing) the deploy role first.
- GitHub now supports an opt-in "immutable" subject claim that appends the
  permanent numeric account and repository IDs to the name, making recycled
  names useless. If you ever opt this repository into that setting, the
  trust policy's `sub` value must be updated to the new format at the same
  time or deploys will stop authenticating.

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
