# The MCP server Lambda. The deploy workflow builds mcp/dist/index.mjs
# (esbuild bundle) before running Terraform; archive_file zips that single
# file, so the function package contains exactly what was built from the
# repo at the deployed commit.

data "archive_file" "server" {
  type        = "zip"
  source_file = "${path.module}/../mcp/dist/index.mjs"
  output_path = "${path.module}/.terraform/bbb-mcp-server.zip"
}

# Execution role: the only thing the running server may do in AWS is write
# its own logs. No other AWS API is reachable from this code by construction.
resource "aws_iam_role" "server_exec" {
  name        = "bbb-mcp-server-exec"
  description = "Execution role for the BBB MCP server Lambda (logs only)"

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
  timeout     = 15

  # Bounds parallel invocations as defense in depth behind the usage-plan
  # throttle: even a gateway misconfiguration can't fan out unbounded compute.
  reserved_concurrent_executions = 10

  environment {
    variables = {
      SUPABASE_URL      = var.supabase_url
      SUPABASE_ANON_KEY = var.supabase_anon_key
    }
  }

  depends_on = [aws_cloudwatch_log_group.server]
}
