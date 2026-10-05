# No backend block and no required_providers: implicit local state, implicit floating provider.
resource "aws_s3_bucket" "assets" {
  bucket = "acme-staging-assets"
  tags   = { Env = "staging" }
}

moved {
  from = aws_s3_bucket.old_assets
  to   = aws_s3_bucket.assets
}

import {
  to = aws_s3_bucket.assets
  id = "acme-staging-assets"
}

resource "aws_security_group" "web" {
  name = "web-staging"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}

resource "aws_db_instance" "main" {
  identifier        = "acme-staging"
  engine            = "postgres"
  instance_class    = "db.t3.small"
  allocated_storage = 50
  password          = var.db_password
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "app-staging"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "${aws_s3_bucket.assets.arn}/*"
    }]
  })
}
