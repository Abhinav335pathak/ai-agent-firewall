output "public_ip" {
  description = "Put this in the EC2_HOST GitHub secret and in the Android app."
  value       = aws_eip.app.public_ip
}

output "app_url" {
  description = "Base URL of the firewall (dashboard at /company-status)."
  value       = "http://${aws_eip.app.public_ip}"
}

output "ssh_command" {
  description = "How to log in to the server."
  value       = "ssh -i ~/.ssh/firewall-ec2-key ubuntu@${aws_eip.app.public_ip}"
}
