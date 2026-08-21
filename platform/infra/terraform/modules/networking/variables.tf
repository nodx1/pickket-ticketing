variable "prefix" {
  description = "Project prefix for resource naming"
  type        = string
  default     = "pickket-v2"
}

variable "environment" {
  description = "Environment name (staging or production)"
  type        = string
  default     = "production"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-northeast-2"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.3.0.0/16"
}

variable "public_subnet_a_cidr" {
  description = "CIDR block for public subnet in AZ a"
  type        = string
  default     = "10.3.1.0/24"
}

variable "public_subnet_c_cidr" {
  description = "CIDR block for public subnet in AZ c"
  type        = string
  default     = "10.3.2.0/24"
}

variable "private_subnet_a_cidr" {
  description = "CIDR block for private subnet in AZ a"
  type        = string
  default     = "10.3.10.0/24"
}

variable "private_subnet_c_cidr" {
  description = "CIDR block for private subnet in AZ c"
  type        = string
  default     = "10.3.11.0/24"
}
