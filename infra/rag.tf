# Bedrock RAG over BBB's own docs (see docs/mcp-rag-design.md).
#
# A Bedrock Knowledge Base (Titan Text Embeddings V2) over an S3 Vectors
# index, fed from a private corpus bucket that the deploy workflow syncs
# from the curated manifest in mcp/corpus-manifest.txt. The server's
# search_docs tool calls bedrock:Retrieve; ask_docs calls
# bedrock:RetrieveAndGenerate with Claude Haiku 4.5 through the au.
# geographic inference profile (Claude is not in-region in Sydney; the
# au. profile routes Sydney + Melbourne).
#
# Ingestion deliberately has no Terraform resource: the deploy workflow
# runs `aws bedrock-agent start-ingestion-job` after a successful apply
# and polls it to completion, so corpus updates ride the normal deploy.

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Permissions ceiling for every role this stack creates. Created by a human
  # in the bootstrap (infra/BOOTSTRAP.md step 3a), NOT by Terraform: the deploy
  # role can version bbb-mcp-* policies, so a Terraform-managed boundary could
  # be widened by the very thing it is meant to constrain. Terraform only
  # references and attaches it; the deploy policy explicitly denies editing it.
  permissions_boundary = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/bbb-mcp-boundary"

  # Titan V2 is in-region; its ARN carries no account id.
  titan_embed_arn = "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2:0"

  haiku_model_id  = "anthropic.claude-haiku-4-5-20251001-v1:0"
  rag_profile_arn = "arn:aws:bedrock:${var.aws_region}:${local.account_id}:inference-profile/au.${local.haiku_model_id}"

  # The au. profile may satisfy a request in either destination region,
  # so InvokeModel must be allowed on the foundation model in both.
  rag_model_region_arns = [
    "arn:aws:bedrock:ap-southeast-2::foundation-model/${local.haiku_model_id}",
    "arn:aws:bedrock:ap-southeast-4::foundation-model/${local.haiku_model_id}",
  ]
}

# ---------------------------------------------------------------------------
# Corpus bucket: the markdown docs the knowledge base indexes. Private;
# written only by the deploy workflow (s3 sync of the curated manifest).
# force_destroy keeps `terraform destroy` a one-command decommission.

resource "aws_s3_bucket" "corpus" {
  bucket        = "bbb-mcp-corpus-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "corpus" {
  bucket                  = aws_s3_bucket.corpus.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "corpus" {
  bucket = aws_s3_bucket.corpus.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------------------------------------------------------------------------
# S3 Vectors: vector bucket + index. Dimensions/metric match Titan V2 as
# Bedrock uses it (1024-dim float32, cosine); the two non-filterable
# metadata keys are the ones Bedrock Knowledge Bases require.

resource "aws_s3vectors_vector_bucket" "docs" {
  vector_bucket_name = "bbb-mcp-vectors"
  force_destroy      = true
}

resource "aws_s3vectors_index" "docs" {
  vector_bucket_name = aws_s3vectors_vector_bucket.docs.vector_bucket_name
  index_name         = "bbb-mcp-docs"
  data_type          = "float32"
  dimension          = 1024
  distance_metric    = "cosine"

  metadata_configuration {
    non_filterable_metadata_keys = [
      "AMAZON_BEDROCK_TEXT",
      "AMAZON_BEDROCK_METADATA",
    ]
  }
}

# ---------------------------------------------------------------------------
# Knowledge base service role: what Bedrock itself may do while indexing
# and retrieving. Read the corpus, use the vector index, invoke the
# embedding model. Trust is conditioned to knowledge bases in this
# account so a confused deputy in another account cannot borrow it.

resource "aws_iam_role" "kb" {
  name                 = "bbb-mcp-kb-role"
  description          = "Service role for the BBB MCP docs knowledge base"
  permissions_boundary = local.permissions_boundary

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "bedrock.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:bedrock:${var.aws_region}:${local.account_id}:knowledge-base/*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "kb" {
  name = "bbb-mcp-kb-policy"
  role = aws_iam_role.kb.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCorpus"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.corpus.arn, "${aws_s3_bucket.corpus.arn}/*"]
      },
      {
        # The specific vector operations Bedrock needs for indexing and
        # retrieval, not s3vectors:*; a missing action would surface as an
        # AccessDenied in the deploy run's ingestion step.
        Sid    = "UseVectorIndex"
        Effect = "Allow"
        Action = [
          "s3vectors:GetVectorBucket",
          "s3vectors:GetIndex",
          "s3vectors:ListIndexes",
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:QueryVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:ListVectors",
        ]
        Resource = [
          aws_s3vectors_vector_bucket.docs.vector_bucket_arn,
          aws_s3vectors_index.docs.index_arn,
        ]
      },
      {
        Sid      = "EmbedWithTitan"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = [local.titan_embed_arn]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# The knowledge base and its S3 data source. Chunking is Bedrock's
# default fixed-size strategy (no vector_ingestion_configuration): the
# corpus is tens of small markdown files.

resource "aws_bedrockagent_knowledge_base" "docs" {
  name        = "bbb-mcp-docs"
  description = "BBB public documentation for the MCP docs Q&A tools"
  role_arn    = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = local.titan_embed_arn
      embedding_model_configuration {
        bedrock_embedding_model_configuration {
          dimensions          = 1024
          embedding_data_type = "FLOAT32"
        }
      }
    }
  }

  storage_configuration {
    type = "S3_VECTORS"
    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.docs.index_arn
    }
  }

  depends_on = [aws_iam_role_policy.kb]
}

resource "aws_bedrockagent_data_source" "docs" {
  knowledge_base_id    = aws_bedrockagent_knowledge_base.docs.id
  name                 = "bbb-mcp-docs-corpus"
  data_deletion_policy = "DELETE"

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn = aws_s3_bucket.corpus.arn
    }
  }
}

# ---------------------------------------------------------------------------
# Runtime permissions for the server Lambda: retrieval on this knowledge
# base, generation through the au. Haiku profile, nothing else.
# bedrock:RetrieveAndGenerate is not resource-scopeable, hence "*" on
# that single action; the models it can reach are still bounded by the
# InvokeModel statement.

resource "aws_iam_role_policy" "server_rag" {
  name = "bbb-mcp-server-rag"
  role = aws_iam_role.server_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RetrieveFromDocsKb"
        Effect   = "Allow"
        Action   = ["bedrock:Retrieve"]
        Resource = [aws_bedrockagent_knowledge_base.docs.arn]
      },
      {
        Sid      = "RetrieveAndGenerate"
        Effect   = "Allow"
        Action   = ["bedrock:RetrieveAndGenerate"]
        Resource = ["*"]
      },
      {
        Sid    = "GenerateWithHaiku"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = concat([local.rag_profile_arn], local.rag_model_region_arns)
      },
      {
        # RetrieveAndGenerate resolves the geographic inference profile's
        # routing before invoking, which requires reading the profile.
        # Without this, retrieval (search_docs) works but generation
        # (ask_docs) fails with AccessDenied -- verified live 2026-08-22.
        Sid      = "ResolveInferenceProfile"
        Effect   = "Allow"
        Action   = ["bedrock:GetInferenceProfile"]
        Resource = [local.rag_profile_arn]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Cost backstop enforced by AWS itself (layer 4 in the design doc): a
# small account-wide budget on actual costs whose action attaches a
# customer-managed Deny bedrock:* policy to the Lambda execution role at
# 100% of budget, ending paid generation even if every other layer were
# bypassed. Budgets cost data lags by hours; the usage-plan quota and
# per-request caps bound spending inside that window.

resource "aws_iam_policy" "bedrock_deny" {
  name        = "bbb-mcp-bedrock-deny"
  description = "Attached to the server role by the budget action to stop all Bedrock calls"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DenyAllBedrock"
      Effect   = "Deny"
      Action   = ["bedrock:*"]
      Resource = ["*"]
    }]
  })
}

resource "aws_iam_role" "budgets" {
  name                 = "bbb-mcp-budgets-action"
  description          = "Execution role for the BBB MCP budget action"
  permissions_boundary = local.permissions_boundary

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "budgets.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "budgets" {
  name = "bbb-mcp-budgets-policy"
  role = aws_iam_role.budgets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Pinned to the one deny policy via iam:PolicyARN, so this role
        # can never be steered into attaching anything else to the server
        # role (e.g. by a rewritten budget action definition).
        Sid    = "AttachDenyToServerRole"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
        ]
        Resource = [aws_iam_role.server_exec.arn]
        Condition = {
          ArnEquals = { "iam:PolicyARN" = aws_iam_policy.bedrock_deny.arn }
        }
      },
      {
        Sid    = "InspectServerRole"
        Effect = "Allow"
        Action = [
          "iam:GetRole",
          "iam:ListAttachedRolePolicies",
        ]
        Resource = [aws_iam_role.server_exec.arn]
      },
    ]
  })
}

resource "aws_budgets_budget" "mcp" {
  name         = "bbb-mcp-monthly"
  budget_type  = "COST"
  limit_amount = var.budget_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
}

resource "aws_budgets_budget_action" "deny_bedrock" {
  budget_name        = aws_budgets_budget.mcp.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budgets.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.bedrock_deny.arn
      roles      = [aws_iam_role.server_exec.name]
    }
  }

  subscriber {
    address           = var.budget_alert_email
    subscription_type = "EMAIL"
  }

  depends_on = [aws_iam_role_policy.budgets]
}
