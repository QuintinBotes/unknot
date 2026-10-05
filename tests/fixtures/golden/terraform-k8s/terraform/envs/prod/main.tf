terraform {
  required_version = ">= 1.6"

  backend "s3" {
    bucket         = "acme-tf-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "acme-tf-locks"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

module "net" {
  source = "../../modules/wrapper"
}

module "registry" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "4.1.2"
}

resource "aws_kms_key" "main" {
  description = "prod data key"
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-prod-assets"
  tags   = { Env = "prod" }
}

resource "aws_security_group" "web" {
  name = "web-prod"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  identifier          = "acme-prod"
  engine              = "postgres"
  instance_class      = "db.r6g.large"
  allocated_storage   = 500
  deletion_protection = true
  kms_key_id          = aws_kms_key.main.arn
  password            = var.db_password

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "app" {
  name = "app-prod"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { "Effect" = "Allow", "Action" = "*", "Resource" = "*" },
      { "Effect" = "Allow", "Action" = "s3:GetObject", "Resource" = aws_s3_bucket.assets.arn },
    ]
  })
}
