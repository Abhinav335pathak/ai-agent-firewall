variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1" # Mumbai
}

variable "project_name" {
  description = "Prefix used for resource names and tags."
  type        = string
  default     = "ai-agent-firewall"
}

variable "instance_type" {
  description = "EC2 size. t3.small (2 GB) is comfortable; t3.micro (1 GB) works without the monitoring stack."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root disk size in GB."
  type        = number
  default     = 20
}

variable "ssh_public_key_path" {
  description = "Path to the PUBLIC key that will be allowed to SSH in (the private half goes into the EC2_SSH_KEY GitHub secret)."
  type        = string
  default     = "~/.ssh/firewall-ec2-key.pub"
}

variable "ssh_allowed_cidr" {
  description = "Who may reach SSH (port 22). GitHub-hosted runners use changing public IPs, so the default is open; access is key-only. Tighten this if you deploy from your own machine."
  type        = string
  default     = "0.0.0.0/0"
}
