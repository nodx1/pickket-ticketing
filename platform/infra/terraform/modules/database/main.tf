################################################################################
# Database Module — Aurora Serverless v2 + RDS Proxy
################################################################################

# --- Subnet Group -----------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${var.prefix}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.prefix}-db-subnet"
  }
}

# --- Aurora Serverless v2 Cluster --------------------------------------------

resource "aws_rds_cluster" "main" {
  cluster_identifier = "${var.prefix}-aurora-v2"
  engine             = "aurora-postgresql"
  engine_version     = "16.1"
  engine_mode        = "provisioned"

  master_username             = "pickket_admin"
  manage_master_user_password = true

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  vpc_security_group_ids = [var.rds_security_group_id]
  db_subnet_group_name   = aws_db_subnet_group.main.name

  storage_encrypted        = true
  # 30-day retention aligns with PIPA / financial-data regulatory expectations
  # for payment records (raised from 7d on 2026-04-21 per production audit).
  backup_retention_period  = 30
  skip_final_snapshot      = var.environment == "staging"
  final_snapshot_identifier = "${var.prefix}-aurora-final-${formatdate("YYYYMMDDHHmmss", timestamp())}"

  tags = {
    Name        = "${var.prefix}-aurora-v2"
    Environment = var.environment
  }
}

# --- Writer Instance ---------------------------------------------------------

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.prefix}-aurora-v2-writer"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  tags = {
    Name = "${var.prefix}-aurora-v2-writer"
  }
}

# --- Reader Instance ---------------------------------------------------------

resource "aws_rds_cluster_instance" "reader" {
  identifier         = "${var.prefix}-aurora-v2-reader"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
  promotion_tier     = 1

  tags = {
    Name = "${var.prefix}-aurora-v2-reader"
  }
}

# --- RDS Proxy ---------------------------------------------------------------

resource "aws_db_proxy" "main" {
  name          = "${var.prefix}-db-proxy"
  engine_family = "POSTGRESQL"
  role_arn      = var.rds_proxy_role_arn
  require_tls   = true

  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [var.rds_security_group_id]

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = var.db_credentials_secret_arn
  }

  tags = {
    Name        = "${var.prefix}-db-proxy"
    Environment = var.environment
  }
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    max_connections_percent      = 100
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_cluster_identifier  = aws_rds_cluster.main.id
}
