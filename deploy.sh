#!/bin/bash
# ──
# AWS EC2 Initialization Script (User Data)
# ──
#
# Deploy this script in EC2 User Data to automatically install Docker,
# fetch secrets from AWS Systems Manager (SSM) Parameter Store,
# and boot the `insider-quant-engine` stack.
#
# Assumptions:
# 1. AMI is Amazon Linux 2023 or Amazon Linux 2.
# 2. An IAM Instance Profile is attached allowing `ssm:GetParameters`.
# 3. An Elastic IP is assigned to this EC2 instance.
# 4. Security Group allows inbound TCP 3000 (from your dynamic IP/Telegram) and SSH.
#
# Expected SSM Parameters (SecureString):
# /quant/TELEGRAM_BOT_TOKEN
# /quant/TELEGRAM_ADMIN_ID
# /quant/TELEGRAM_CHANNEL_ID
# /quant/FYERS_APP_ID
# /quant/FYERS_SECRET_ID
# /quant/FYERS_REDIRECT_URI  <-- Must point to http://<EC2_ELASTIC_IP>:3000/callback
# ──

set -e

# 1. Update system & install dependencies
yum update -y
yum install -y docker git jq jq
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install docker-compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# 2. Clone the repo (or use the one copied if running this locally)
# NOTE: Replace with the actual GitHub repo URL if cloning dynamically.
cd /home/ec2-user
if [ ! -d "insider-quant-engine" ]; then
    # In a real environment, you might clone the private repo using an SSH key or token from Secrets Manager.
    # For now, we assume the code is deployed via CodeDeploy, manual git clone, or similar.
    echo "Please ensure the code is located at /home/ec2-user/insider-quant-engine"
    # To auto-clone, you would do: git clone https://github.com/user/insider-quant-engine.git
fi

# Wait for the directory (in case of async provisioning)
while [ ! -d "/home/ec2-user/insider-quant-engine" ]; do
    sleep 5
done

cd /home/ec2-user/insider-quant-engine

# 3. Fetch secrets from SSM and build .env
echo "Fetching secrets from SSM Parameter Store..."
aws ssm get-parameters \
    --names \
        "/quant/TELEGRAM_BOT_TOKEN" \
        "/quant/TELEGRAM_ADMIN_ID" \
        "/quant/TELEGRAM_CHANNEL_ID" \
        "/quant/FYERS_APP_ID" \
        "/quant/FYERS_SECRET_ID" \
        "/quant/FYERS_REDIRECT_URI" \
    --with-decryption \
    --region ap-south-1 \
    --query "Parameters[*].[Name,Value]" \
    --output text | while read -r name value; do
        # Extract the key name by stripping the prefix (e.g. /quant/TELEGRAM_BOT_TOKEN -> TELEGRAM_BOT_TOKEN)
        key=$(basename "$name")
        echo "${key}=${value}" >> .env
done

# Set permissions
chown ec2-user:ec2-user .env
chmod 600 .env

# 4. Boot the scheduler (which will manage the rest of the daily lifecycle)
# We only start the scheduler and redis. The scheduler handles auth/engine via crontab.
echo "Building and starting the Docker Compose stack..."
/usr/local/bin/docker-compose up -d --build redis_cache quant_scheduler

echo "✅ AWS Deployment initialization complete."
