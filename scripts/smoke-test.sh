#!/usr/bin/env bash
# Black-box checks against a RUNNING stack (local, CI, or the live EC2 server).
#
#   ./scripts/smoke-test.sh http://localhost
#   ./scripts/smoke-test.sh http://<EC2_IP> --after-demo   # also verify state after the 4 scenarios ran
#
# The default checks are non-destructive: they only call read_logs (allowed) and
# delete_prod_db (which must be blocked), so they are safe to run on the production demo box.
set -uo pipefail

BASE="${1:-http://localhost}"
BASE="${BASE%/}"
MODE="${2:-}"
HOST="$(echo "$BASE" | sed -E 's#^https?://##; s#[:/].*$##')"
FAILS=0
if [ -f .env ]; then
  ADMIN_TOKEN="${ADMIN_TOKEN:-$(sed -n 's/^ADMIN_TOKEN=//p' .env)}"
  AGENT_TOKEN="${AGENT_TOKEN:-$(sed -n 's/^AGENT_TOKEN=//p' .env)}"
fi
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; FAILS=$((FAILS + 1)); }

post_status() { # post_status <action>  -> prints HTTP status
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/agent/execute" \
    -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' -d "{\"agentId\":\"smoke-test\",\"action\":\"$1\"}"
}

echo "Smoke test against $BASE"

# 1. wait for the stack
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" = 1 ]; then pass "firewall /health is up"; else fail "firewall /health never became ready"; exit 1; fi

# 2. policy enforcement
[ "$(post_status read_logs)" = "200" ] && pass "read_logs is ALLOWED (200)" || fail "read_logs should return 200"
[ "$(post_status delete_prod_db)" = "403" ] && pass "delete_prod_db is BLOCKED (403)" || fail "delete_prod_db must return 403"

# 3. the real database is intact
status_json="$(curl -fsS --max-time 10  -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/company-status.json" || true)"
if echo "$status_json" | grep -q 'Alice Sharma'; then pass "production customers are intact"; else fail "customers table missing or empty"; fi

# 4. the data tier is not exposed to the outside world
for port in 3000 4000 5432; do
  if timeout 3 bash -c "exec 3<>/dev/tcp/$HOST/$port" 2>/dev/null; then
    fail "port $port is reachable from outside - it must be closed"
  else
    pass "port $port is not exposed"
  fi
done

# 5. optional: state after the full demo ran
if [ "$MODE" = "--after-demo" ]; then
  echo "$status_json" | grep -q 'dev-worker-02' && pass "approved VM exists in the database" || fail "dev-worker-02 not found"
  echo "$status_json" | grep -q 'SUPER_ADMIN' && fail "IAM was elevated although it was rejected" || pass "rejected IAM change did not happen"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi
