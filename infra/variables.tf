variable "aws_region" {
  description = "Deployment region. Sydney, matching the audience of the data."
  type        = string
  default     = "ap-southeast-2"
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

# Reserved concurrency for the Lambda. Default -1 = no reservation, which is
# the only value that applies cleanly on a brand-new AWS account: fresh
# accounts often have a low regional Lambda concurrency limit, and AWS
# refuses any reservation that would drop unreserved concurrency below 100.
# The API Gateway usage plan already bounds fan-out; once the account's
# concurrency limit is raised, set this (e.g. 10) for defense in depth.
variable "lambda_reserved_concurrency" {
  description = "Lambda reserved concurrent executions (-1 = unreserved)."
  type        = number
  default     = -1
}

# Abuse/cost caps enforced by the API Gateway usage plan. With ask_docs
# able to trigger paid generation (~USD 0.01 worst case per call), the
# monthly quota is the front-door arithmetic ceiling on spend: it is
# shared across all tools, so quota x worst-case-cost bounds the month
# (~USD 5 at the default) before the budget action ever engages. Sized
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
  description = "Hard cap on requests per API key per calendar month."
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

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}
