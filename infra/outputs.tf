output "mcp_endpoint" {
  description = "The MCP endpoint URL. Callers POST here with the x-api-key header."
  value       = "${aws_api_gateway_stage.prod.invoke_url}/mcp"
}

output "lambda_function_name" {
  description = "Deployed Lambda function name."
  value       = aws_lambda_function.server.function_name
}

output "api_key_name" {
  description = "Name of the private API key resource. The VALUE is deliberately not output; retrieve it in CloudShell per infra/BOOTSTRAP.md."
  value       = aws_api_gateway_api_key.mcp.name
}

output "demo_api_key_name" {
  description = "Name of the API key resource for general distribution. The VALUE is deliberately not output; retrieve it in CloudShell per infra/BOOTSTRAP.md."
  value       = aws_api_gateway_api_key.demo.name
}

# Consumed by the corpus sync (both the deploy workflow's post-apply run
# and the ungated docs publisher, which reads them from repo variables).
# None of these are secrets.
output "knowledge_base_id" {
  description = "Bedrock knowledge base id for the docs corpus."
  value       = aws_bedrockagent_knowledge_base.docs.id
}

output "data_source_id" {
  description = "Data source id within the docs knowledge base."
  value       = aws_bedrockagent_data_source.docs.data_source_id
}

output "corpus_bucket" {
  description = "S3 bucket the curated docs corpus is synced to."
  value       = aws_s3_bucket.corpus.bucket
}
