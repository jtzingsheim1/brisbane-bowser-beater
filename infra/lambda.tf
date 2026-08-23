# The MCP server Lambda. The deploy workflow builds mcp/dist/index.mjs
# (esbuild bundle) before running Terraform; archive_file zips that single
# file, so the function package contains exactly what was built from the
# repo at the deployed commit.

data "archive_file" "server" {
  type        = "zip"
  source_file = "${path.module}/../mcp/dist/index.mjs"
  output_path = "${path.module}/.terraform/bbb-mcp-server.zip"
}

# Execution role: the running server may write its own logs and call the
# scoped Bedrock retrieval/generation APIs (see aws_iam_role_policy.server_rag
# in rag.tf). No other AWS API is reachable from this code by construction.
resource "aws_iam_role" "server_exec" {
  name = "bbb-mcp-server-exec"
  # Description deliberately left at its original value: editing it calls
  # iam:UpdateRoleDescription, which the least-privilege deploy role does
  # not (and need not) hold. The role's real, current capability is defined
  # by its attached policies (logs + the scoped Bedrock policy in rag.tf),
  # not by this cosmetic string.
  description = "Execution role for the BBB MCP server Lambda (logs only)"

  # Ceiling on what this role can ever hold, even if a compromised or mistaken
  # deploy rewrites its policy. The workload ceiling carries no IAM actions at
  # all, so no rewritten policy here can reach the bedrock-deny cost backstop
  # attached to this same role (see local.boundary_workload in rag.tf).
  permissions_boundary = local.boundary_workload

  # The budget action attaches bbb-mcp-bedrock-deny to this role outside
  # Terraform's knowledge when it fires. force_detach_policies keeps the
  # role destroyable in that state, and depending on the deny policy makes
  # destroy tear the role down (auto-detaching) before deleting the policy
  # itself, so `terraform destroy` stays a full decommission even after a
  # triggered backstop.
  force_detach_policies = true
  depends_on            = [aws_iam_policy.bedrock_deny]

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "server_logs" {
  name = "bbb-mcp-server-logs"
  role = aws_iam_role.server_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.server.arn}:*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "server" {
  name              = "/aws/lambda/bbb-mcp-server"
  retention_in_days = 30
}

resource "aws_lambda_function" "server" {
  function_name = "bbb-mcp-server"
  description   = "Read-only MCP server over BBB's public Brisbane fuel price forecast data"
  role          = aws_iam_role.server_exec.arn

  filename         = data.archive_file.server.output_path
  source_code_hash = data.archive_file.server.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]

  memory_size = 256
  # 25s leaves headroom over the data layer's worst cases (two sequential
  # 6s upstream fetches = 12s; one ask_docs RetrieveAndGenerate round trip
  # with a 500-token generation cap) so an upstream stall degrades to a
  # graceful tool error rather than a hard Lambda kill, while staying
  # under API Gateway's 29s integration limit.
  timeout = 25

  # Bounds parallel invocations as defense in depth behind the usage-plan
  # throttle. Defaults to unreserved (-1) so the first apply succeeds on a
  # fresh, low-concurrency-limit account; see var.lambda_reserved_concurrency.
  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = {
      SUPABASE_URL      = var.supabase_url
      SUPABASE_ANON_KEY = var.supabase_anon_key
      # RAG tools (see infra/rag.tf); the server skips registering them
      # when these are absent.
      BBB_KB_ID         = aws_bedrockagent_knowledge_base.docs.id
      BBB_RAG_MODEL_ARN = local.rag_profile_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.server]
}
