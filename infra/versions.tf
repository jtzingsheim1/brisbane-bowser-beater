# Single-stack IaC for the BBB MCP server. Everything the subproject needs
# in AWS lives in this one root module, so `terraform destroy` is a complete
# decommission (see infra/BOOTSTRAP.md for the few one-time resources that
# live outside the stack: the OIDC provider, deploy role, and state bucket).

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
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
