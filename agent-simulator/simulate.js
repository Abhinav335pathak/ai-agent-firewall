#!/usr/bin/env node
'use strict';

/**
 * Scripted "AI agent". Fires 4 realistic actions at the firewall, one after another.
 *
 *   node simulate.js                                 # against http://localhost
 *   node simulate.js --url http://<EC2_IP>           # against the cloud demo server
 *   node simulate.js --auto-approve --assert         # hands-free, for CI (needs ADMIN_TOKEN)
 *   node simulate.js --only 4                        # run just scenario 4
 *
 * No dependencies: uses the built-in fetch of Node 20+.
 */

const { parseArgs } = require('node:util');

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    delay: { type: 'string' },
    only: { type: 'string' },
    'auto-approve': { type: 'boolean', default: false },
    assert: { type: 'boolean', default: false },
  },
});

const BASE = (opts.url || process.env.FIREWALL_URL || 'http://localhost').replace(/\/$/, '');
const DELAY_MS = Number(opts.delay ?? process.env.STEP_DELAY_MS ?? 3000);
const TOKEN = process.env.ADMIN_TOKEN || '';
const AUTO = opts['auto-approve'];
const ASSERT = opts.assert;
const AGENT = 'DemoAgent-01';

if (ASSERT && !AUTO) {
  console.error('--assert only makes sense with --auto-approve (a human would decide otherwise)');
  process.exit(2);
}
if (AUTO && !TOKEN) {
  console.error('--auto-approve needs the ADMIN_TOKEN environment variable');
  process.exit(2);
}

// ciApprove: what the robot reviewer does in --auto-approve mode (null = nothing to decide)
const SCENARIOS = [
  { id: 1, name: 'Read server logs', action: 'read_logs', target: 'prod-web-server-01', expect: 200, ciApprove: null },
  { id: 2, name: 'Spin up a dev server', action: 'spin_up_dev_vm', target: 'dev', expect: 200, ciApprove: true },
  { id: 3, name: 'Change admin permissions', action: 'change_iam_permissions', target: 'ai-agent', expect: 403, ciApprove: false },
  { id: 4, name: 'Delete the production database', action: 'delete_prod_db', target: 'company_prod.customers', expect: 403, ciApprove: null },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ICON = { ALLOWED: '✅', APPROVED: '✅', BLOCKED: '⛔', REJECTED: '🚫', TIMED_OUT: '⏱️', ERROR: '💥' };

/** Plays the human reviewer for CI: waits for the pending request, then approves/rejects it. */
async function robotReviewer(action, approved, state) {
  while (!state.done) {
    const list = await fetch(`${BASE}/approvals/pending`).then((r) => r.json()).catch(() => []);
    const hit = list.find((e) => e.action === action && e.agent === AGENT);
    if (hit) {
      const r = await fetch(`${BASE}/approval/${hit.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ approved }),
      });
      if (r.status === 401) {
        console.error('\n    💥 robot reviewer was refused (HTTP 401): ADMIN_TOKEN does not match the server');
        process.exit(1);
      }
      return;
    }
    await sleep(250);
  }
}

async function run(s) {
  console.log(`\n[${s.id}] ${s.name}`);
  console.log(`    agent wants: ${s.action}  ->  ${s.target}`);
  if (!AUTO && s.action !== 'read_logs' && s.action !== 'delete_prod_db') {
    console.log('    (may pause here until a human taps Approve/Reject in the app - 30s timeout)');
  }

  const state = { done: false };
  const reviewer = AUTO && s.ciApprove !== null ? robotReviewer(s.action, s.ciApprove, state) : null;

  let res;
  let data = {};
  try {
    res = await fetch(`${BASE}/agent/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: AGENT, action: s.action, target: s.target, payload: {} }),
      signal: AbortSignal.timeout(60000),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    state.done = true;
    console.log(`    💥 request failed: ${err.message}`);
    return { s, ok: false, status: 0 };
  }
  state.done = true;
  if (reviewer) await reviewer;

  const label = data.status || 'UNKNOWN';
  console.log(`    ${ICON[label] || '❔'} firewall says: ${label} (HTTP ${res.status})${data.reason ? ' - ' + data.reason : ''}`);
  return { s, ok: res.status === s.expect, status: res.status };
}

(async () => {
  console.log(`AI agent simulator -> ${BASE}`);
  const list = opts.only ? SCENARIOS.filter((s) => String(s.id) === opts.only) : SCENARIOS;
  const results = [];
  for (let i = 0; i < list.length; i++) {
    results.push(await run(list[i]));
    if (i < list.length - 1) await sleep(DELAY_MS);
  }

  if (ASSERT) {
    const bad = results.filter((r) => !r.ok);
    console.log('');
    results.forEach((r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.s.id}] ${r.s.action} (expected HTTP ${r.s.expect}, got ${r.status})`));
    if (bad.length) process.exit(1);
    console.log('\nAll scenarios behaved as the policy requires.');
  }
})();
