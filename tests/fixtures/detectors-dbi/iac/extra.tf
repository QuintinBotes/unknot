terraform {
  backend "s3" {
    bucket  = "acme-state"
    key     = "extra/terraform.tfstate"
    region  = "us-east-1"
    encrypt = false
  }
}

resource "aws_db_instance" "orders" {
  identifier              = "orders-prod"
  engine                  = "postgres"
  instance_class          = "db.r6g.large"
  allocated_storage       = 500
  backup_retention_period = 0
  deletion_protection     = false
  publicly_accessible     = true
  skip_final_snapshot     = true
}

resource "aws_db_instance" "ledger" {
  identifier              = "ledger-prod"
  engine                  = "postgres"
  instance_class          = "db.r6g.large"
  allocated_storage       = 100
  backup_retention_period = 14
  deletion_protection     = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "open" {
  name = "open"

  ingress {
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_s3_bucket" "public" {
  bucket = "acme-public-dump"
  acl    = "public-read"
}

resource "aws_iam_policy" "admin" {
  name   = "everything"
  policy = <<-POLICY
    {
      "Version": "2012-10-17",
      "Statement": [{ "Effect": "Allow", "Action": "*", "Resource": "*" }]
    }
  POLICY
}

resource "aws_iam_access_key" "deploy" {
  user = "deploy-bot"
}
