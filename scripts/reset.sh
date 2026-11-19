#!/usr/bin/env bash
# One-command stage reset: restores the company database to its seed data,
# clears the audit trail and the live feed. Run this right before presenting.
#
#   ADMIN_TOKEN=<token> ./scripts/reset.sh http://<EC2_IP>
set -euo pipefail

BASE="${1:-http://localhost}"
: "${ADMIN_TOKEN:?export ADMIN_TOKEN first (on the server: grep ADMIN_TOKEN ~/app/.env)}"

curl -fsS -X POST "${BASE%/}/admin/reset" -H "Authorization: Bearer ${ADMIN_TOKEN}"
echo
echo "Reset done. Company DB restored. Production audit history is preserved; local audit clearing requires ALLOW_AUDIT_RESET=true."
