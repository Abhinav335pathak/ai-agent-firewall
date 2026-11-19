#!/usr/bin/env node
'use strict';

// Use only with a disposable local/CI database: this test creates one customer.
const assert = require('node:assert/strict');
const BASE = (process.argv[2] || 'http://localhost').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN;
const AGENT = `sql-test-${Date.now()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, body, token) {
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  return { status: response.status, data: await response.json() };
}
const execute = (sql, action = 'execute_sql') => request('/agent/execute', { agentId: AGENT, action, payload: { sql } });

async function pendingRequest() {
  for (let i = 0; i < 100; i++) {
    const pending = (await request('/approvals/pending')).data.find((entry) => entry.agent === AGENT);
    if (pending) return pending;
    await sleep(25);
  }
  throw new Error('Approval request did not appear');
}

async function reviewed(sql, approved, action = 'execute_sql') {
  const result = execute(sql, action);
  const pending = await pendingRequest();
  assert.equal(pending.action, 'sql_write');
  assert.equal(pending.sql, sql);
  assert.equal((await request(`/approval/${pending.id}`, { approved })).status, 401);
  assert.equal((await request(`/approval/${pending.id}`, { approved }, TOKEN)).status, 200);
  return result;
}

async function main() {
  assert.equal(process.env.ALLOW_SQL_TEST_WRITES, 'true', 'Set ALLOW_SQL_TEST_WRITES=true only for a disposable test database');
  assert.ok(TOKEN, 'ADMIN_TOKEN is required');
  assert.equal((await request('/health')).data.status, 'ok');
  const before = await execute('SELECT COUNT(*) AS total FROM customers');
  assert.equal(before.status, 200);
  assert.equal(before.data.classifiedAction, 'sql_read');
  const count = Number(before.data.data.rows[0].total);
  console.log('PASS SELECT executes against real PostgreSQL');

  const insert = `INSERT INTO customers(name,email,plan) VALUES ('SQL QA','${AGENT}@example.test','Pro') RETURNING id`;
  const created = await reviewed(insert, true);
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'APPROVED');
  const id = created.data.data.rows[0].id;
  assert.ok(id);
  console.log('PASS INSERT waits for authenticated approval and persists');

  const rejected = await reviewed(`UPDATE customers SET plan = 'Rejected' WHERE id = ${id}`, false);
  assert.equal(rejected.status, 403);
  const spoofed = await reviewed(`UPDATE customers SET plan = 'Spoofed' WHERE id = ${id}`, false, 'sql_read');
  assert.equal(spoofed.status, 403);
  console.log('PASS rejected writes and caller-supplied sql_read cannot bypass approval');

  const timeout = await execute(`UPDATE customers SET plan = 'Timed out' WHERE id = ${id}`);
  assert.equal(timeout.status, 408);
  assert.equal(timeout.data.status, 'TIMED_OUT');
  console.log('PASS unanswered SQL writes time out without executing');

  for (const [sql, action] of [
    ['DROP TABLE customers', 'execute_sql'],
    ['DROP TABLE customers', 'sql_read'],
    ['SELECT 1; DELETE FROM customers', 'execute_sql'],
    ['SELECT * INTO backup FROM customers', 'execute_sql'],
    ["SELECT pg_read_file('/etc/passwd')", 'execute_sql'],
    [null, 'execute_sql'],
  ]) {
    const result = await execute(sql, action);
    assert.equal(result.status, 403);
    assert.equal(result.data.classifiedAction, 'sql_destructive');
  }
  console.log('PASS destructive, stacked, file-access and malformed SQL are blocked');

  assert.equal((await execute('SELECT nonexistent_column FROM customers')).status, 502);
  const after = await execute(`SELECT plan FROM customers WHERE id = ${id}`);
  assert.equal(after.data.data.rows[0].plan, 'Pro');
  const total = await execute('SELECT COUNT(*) AS total FROM customers');
  assert.equal(Number(total.data.data.rows[0].total), count + 1);
  const logs = (await request('/logs?limit=100')).data.filter((entry) => entry.agent === AGENT);
  for (const decision of ['ALLOWED', 'APPROVED_BY_HUMAN', 'REJECTED_BY_HUMAN', 'TIMED_OUT', 'BLOCKED', 'ERROR']) {
    assert.ok(logs.some((entry) => entry.decision === decision && typeof entry.detail?.sql === 'string'), `Missing SQL audit: ${decision}`);
  }
  console.log('PASS data remains intact, failed SQL recovers, and all outcomes are audited');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
