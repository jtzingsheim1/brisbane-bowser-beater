# Single-stack IaC for the BBB MCP server. Everything a deploy manages lives
# in this one root module, so `terraform destroy` removes all of it. A human
# creates the rest in infra/BOOTSTRAP.md, outside the stack: the OIDC
# provider, the three GitHub Actions roles (update, deploy, corpus-sync),
# the two permissions boundaries, the cost backstop (budget, budget action,
# deny policy and the action's role), the zero-spend budget and the state
# bucket. Its "Decommissioning" section covers those, and the order.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      # The RAG stack needs the S3 Vectors + Bedrock agent resources,
      # available from 6.27 per the provider docs. The exact version in use
      # is pinned in .terraform.lock.hcl, which Dependabot keeps current.
      source  = "hashicorp/aws"
      version = ">= 6.27.0, < 7.0.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Bucket and region are supplied at init time by the deploy workflow
  # (-backend-config), because the bootstrap bucket name embeds the AWS
  # account id. State locking uses S3's native lockfile (Terraform >= 1.10),
  # so no DynamoDB table is needed.
  backend "s3" {
    key          = "bbb-mcp/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      project    = "bbb-mcp"
      managed_by = "terraform"
      repository = "jtzingsheim1/brisbane-bowser-beater"
    }
  }
}
