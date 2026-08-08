variable "aws_region" {
  description = "Deployment region. Sydney, matching the audience of the data."
  type        = string
  default     = "ap-southeast-2"
}

# Both Supabase values are public by design: they ship in the website's
# client bundle, and Postgres grants/RLS limit the anon role to the same
# aggregate read paths the site itself uses. They are variables (not
# hardcoded) purely so key rotation never needs a code change.
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

# Abuse/cost caps enforced by the API Gateway usage plan. The free-tier
# budget is monthly Lambda requests (1M) and compute; these defaults keep a
# fully saturated abuser well inside both.
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
  default     = 100000
}
