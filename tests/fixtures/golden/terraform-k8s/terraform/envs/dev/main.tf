resource "aws_s3_bucket" "assets" {
  bucket = "acme-dev-assets"
  tags = {
    Env = "dev"
  }
}

resource "aws_security_group" "web" {
  name = "web-dev"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}

resource "aws_db_instance" "main" {
  identifier        = "acme-dev"
  engine            = "postgres"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  password          = var.db_password
}

resource "aws_iam_role" "app" {
  name = "app-dev"
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
  name   = "app"
  role   = aws_iam_role.app.id
  policy = <<-POLICY
    {
      "Version": "2012-10-17",
      "Statement": [
        { "Effect": "Allow", "Action": "s3:*", "Resource": "${aws_s3_bucket.assets.arn}/*" }
      ]
    }
  POLICY
}
