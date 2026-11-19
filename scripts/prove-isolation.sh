#!/usr/bin/env bash
# Demo helper: proves the agent has NO network route to the company systems.
# Runs inside the agent container (same network position as a real agent).
#
# Run from the repo root on the machine where the stack is running:
#   ./scripts/prove-isolation.sh
set -uo pipefail

try() { # try <label> <url> <expect: reachable|unreachable>
  if docker compose run --rm --no-deps -T --entrypoint wget agent-simulator -T 3 -qO- "$2" >/dev/null 2>&1; then
    result="reachable"
  else
    result="unreachable"
  fi
  if [ "$result" = "$3" ]; then echo "OK    $1 -> $result (expected)"; else echo "BAD   $1 -> $result (expected $3)"; BAD=1; fi
}

BAD=0
echo "From inside the AI agent's container:"
try "firewall-proxy      " http://firewall-proxy:3000/health reachable
try "company-api-server  " http://company-api-server:4000/health unreachable
try "company-postgres-db " http://company-postgres-db:5432 unreachable
try "audit-db            " http://audit-db:5432 unreachable

echo
if [ "$BAD" = 0 ]; then echo "The agent can only reach the firewall. Isolation holds."; else echo "ISOLATION BROKEN" >&2; exit 1; fi
