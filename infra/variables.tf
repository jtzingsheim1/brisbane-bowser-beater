variable "aws_region" {
  description = "Deployment region. Sydney, matching the audience of the data."
  type        = string
  default     = "ap-southeast-2"

  # The RAG stack pins Claude Haiku 4.5 foundation-model ARNs to the au.
  # inference profile's two destination regions (see rag.tf), so deploying
  # anywhere else would silently mismatch the profile ARN in the Lambda
  # environment. Fail at plan time instead.
  validation {
    condition     = contains(["ap-southeast-2", "ap-southeast-4"], var.aws_region)
    error_message = "aws_region must be an au. inference-profile destination region (ap-southeast-2 or ap-southeast-4)."
  }
}

# Both Supabase values are the publishable (low-privilege) tier: Postgres
# grants/RLS limit the anon role to the same aggregate read paths the site
# itself uses, so possession of the key confers nothing beyond public data.
# They are variables (not hardcoded) purely so key rotation never needs a
# code change.
variable "supabase_url" {
  description = "Supabase project URL (public)."
  type        = string

  validation {
    condition     = startswith(var.supabase_url, "https://")
    error_message = "supabase_url must be an https URL."
  }
}

variable "supabase_anon_key" {
  description = "Supabase publishable (anon) key (public by design)."
  type        = string
  # Public by design, but marked sensitive so it stays out of plan output.
  sensitive = true
}

# Reserved concurrency for the Lambda. Stays at -1 (no reservation) as a
# decision, not as a pending task: considered and dropped 2026-08-23 under
# issue #101. A reservation bounds burst, but burst is not what costs money
# here. The usage-plan quota caps the month at a fixed request count, and a
# fixed number of calls costs the same serially or in parallel, so
# concurrency does not enter the spend ceiling (Lambda compute at that
# ceiling is ~USD 0.08, inside the free tier). Its other purpose, keeping
# one function from starving others, has nothing to apply to in a
# single-function account, and the usage plan is enforced at the gateway
# before the function is ever invoked. Setting it also needs regional
# headroom: AWS refuses any reservation that would drop unreserved
# concurrency below 100, so a low limit would have to be raised first.
# See docs/mcp-rag-design.md, cost guards layer 2, for the two caveats
# kept against this. Revisit only if the quota is raised substantially,
# many more keys are added, or a second function joins the account.
variable "lambda_reserved_concurrency" {
  description = "Lambda reserved concurrent executions (-1 = unreserved)."
  type        = number
  default     = -1
}

# Abuse/cost caps enforced by the API Gateway usage plan. With ask_docs
# able to trigger paid generation (~USD 0.01 worst case per call), the
# monthly quota is the front-door ceiling on how many paid calls can be
# made at all: it is shared across all tools but metered PER KEY, so the
# ceiling scales with key count (two keys today = 1000 requests). Sized
# for near-zero real traffic; raise deliberately if usage appears.
variable "throttle_rate_limit" {
  description = "Steady-state requests per second allowed per API key."
  type        = number
  default     = 5
}

variable "throttle_burst_limit" {
  description = "Burst requests allowed per API key."
  type        = number
  default     = 10
}

variable "monthly_quota" {
  # API Gateway enforces usage-plan quotas on a best-effort basis (small
  # overshoot under burst is possible); the budget action in rag.tf is the
  # firm backstop behind it.
  description = "Cap on requests per API key per calendar month."
  type        = number
  default     = 500
}

# Cost backstop (see infra/rag.tf): account-wide monthly budget in USD.
# At 100% of actual spend the budget action attaches a Deny bedrock:*
# policy to the server role, ending paid generation.
variable "budget_limit_usd" {
  description = "Monthly account-wide budget (USD) for the deny-Bedrock action."
  type        = string
  default     = "5.0"
}

variable "budget_alert_email" {
  description = "Email notified when the budget action triggers."
  type        = string
  # Not a credential, but a personal address: sensitive keeps it out of
  # plan/apply output in the public repo's workflow logs.
  sensitive = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}
