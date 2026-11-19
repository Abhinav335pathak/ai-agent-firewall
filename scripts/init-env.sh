#!/usr/bin/env bash
# Creates ~/app/.env with strong random secrets on the FIRST deploy only.
# Secrets are generated on the server, so they never appear in git, CI logs or Terraform state.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo "[init-env] .env already exists - leaving it untouched"
  exit 0
fi

: "${DOCKERHUB_USERNAME:?DOCKERHUB_USERNAME must be set for the first deploy}"

umask 077
cat > .env <<EOF
DOCKERHUB_USERNAME=${DOCKERHUB_USERNAME}
IMAGE_TAG=${IMAGE_TAG:-latest}
COMPANY_DB_PASSWORD=$(openssl rand -hex 16)
AUDIT_DB_PASSWORD=$(openssl rand -hex 16)
INTERNAL_API_TOKEN=$(openssl rand -hex 24)
ADMIN_TOKEN=$(openssl rand -hex 16)
APPROVAL_TIMEOUT_MS=30000
ALLOW_AUDIT_RESET=true
EOF

echo "[init-env] created .env with fresh random secrets"
echo "[init-env] read your admin token with:  grep ADMIN_TOKEN ~/app/.env"
