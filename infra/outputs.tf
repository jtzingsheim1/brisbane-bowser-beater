output "mcp_endpoint" {
  description = "The MCP endpoint URL. Callers POST here with the x-api-key header."
  value       = "${aws_api_gateway_stage.prod.invoke_url}/mcp"
}

output "lambda_function_name" {
  description = "Deployed Lambda function name."
  value       = aws_lambda_function.server.function_name
}

output "api_key_name" {
  description = "Name of the API key resource. The VALUE is deliberately not output; retrieve it in CloudShell per infra/BOOTSTRAP.md."
  value       = aws_api_gateway_api_key.mcp.name
}
