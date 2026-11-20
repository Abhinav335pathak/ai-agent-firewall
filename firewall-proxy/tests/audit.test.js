'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditStore } = require('../src/audit');
const { gateway } = require('./helpers/gateway');

test('durable audit failure rejects instead of confirming an unrecorded action', async () => {
  const audit = new AuditStore('');
  audit.memoryOnly = false;
  audit.pool = { query: async () => { throw new Error('database offline'); } };
  await assert.rejects(audit.record({ id: 'test', detail: {} }), { status: 503 });
  assert.equal(audit.ok, false);
  assert.equal(audit.memory.length, 0);
});

test('restart cancels pending work and marks started execution unconfirmed', async () => {
  const audit = new AuditStore('');
  audit.memoryOnly = false;
  const writes = [];
  audit.pool = { query: async (sql, args) => {
    if (args) { writes.push(args); return {}; }
    return { rows: ['PENDING_APPROVAL', 'EXECUTING'].map((decision, i) => ({ request_id: `id-${i}`, agent: 'demo-agent', action: 'sql_write', risk: 'HIGH', policy_decision: 'REQUIRE_APPROVAL', decision, detail: { sql: 'UPDATE customers SET plan = 1' } })) };
  } };
  await audit.recoverPending();
  assert.equal(writes[0][7], 'CANCELLED');
  assert.equal(writes[1][7], 'EXECUTION_UNCONFIRMED');
  assert.match(writes[0][9], /process restarted/);
});

test('invalid input, unauthorized access, policy version and reviewer are audited by the server', async (t) => {
  const app = await gateway({ APPROVAL_TIMEOUT_MS: '2000' });
  t.after(() => app.close());
  await app.request('/agent/execute', { action: 'Bad-Action' });
  await app.request('/logs', undefined, '');
  const result = app.request('/agent/execute', { action: 'execute_sql', payload: { sql: "UPDATE customers SET plan = 'Pro'" } });
  let pending;
  for (let i = 0; i < 50; i++) {
    const list = await app.request('/approvals/pending', undefined, 'qa-reviewer');
    if (list.data.length) { pending = list.data[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending);
  assert.equal((await app.request(`/approval/${pending.id}`, { approved: true }, 'qa-reviewer')).status, 200);
  assert.equal((await result).status, 200);
  const { data } = await app.request('/logs?limit=100', undefined, 'qa-reviewer');
  assert.ok(data.some((entry) => entry.decision === 'INVALID'));
  assert.ok(data.some((entry) => entry.decision === 'UNAUTHORIZED'));
  const approved = data.find((entry) => entry.decision === 'APPROVED_BY_HUMAN');
  assert.equal(approved.detail.reviewedBy, 'admin');
  assert.equal(typeof approved.detail.policyVersion, 'string');
  assert.equal(approved.detail.sql, pending.sql);
});
