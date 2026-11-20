#!/usr/bin/env bash
# Demo helper: proves the agent has NO network route to the company systems.
# Runs inside the agent container (same network position as a real agent).
#
# Run from the repo root on the machine where the stack is running:
#   ./scripts/prove-isolation.sh
set -uo pipefail

docker compose run --rm --no-deps -T --entrypoint node agent-simulator -e '
const net = require("node:net");
(async () => {
  let failures = 0;
  for (const [host, port, expected] of [["firewall-proxy", 3000, true], ["company-api-server", 4000, false], ["company-postgres-db", 5432, false], ["audit-db", 5432, false]]) {
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(3000);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    console.log(`${reachable === expected ? "PASS" : "FAIL"} ${host}:${port} ${reachable ? "reachable" : "unreachable"}`);
    if (reachable !== expected) failures++;
  }
  process.exitCode = failures ? 1 : 0;
})();'
