'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestStore } = require('../src/requestStore');
const { gateway } = require('./helpers/gateway');

test('same identity/key returns cached result, different bodies conflict and other identities stay separate', async () => {
  const store = new RequestStore(null);
  await store.init();
  assert.ok((await store.reserve('a', 'unique-key', { b: 2, a: 1 })).id);
  assert.equal((await store.reserve('a', 'unique-key', { a: 1, b: 2 })).pending, true);
  assert.equal((await store.reserve('a', 'unique-key', { a: 3 })).conflict, true);
  await store.complete('a', 'unique-key', 200, { status: 'ALLOWED' });
  assert.deepEqual((await store.reserve('a', 'unique-key', { a: 1, b: 2 })).replay, { status: 200, body: { status: 'ALLOWED' } });
  assert.ok((await store.reserve('b', 'unique-key', { a: 1 })).id);
});

test('completed HTTP requests replay once and mismatched retries never execute', async (t) => {
  const app = await gateway(); t.after(() => app.close());
  const headers = { 'idempotency-key': 'same-http-request' };
  const body = { action: 'read_logs' };
  const a = await app.request('/agent/execute', body, 'qa-agent', headers);
  const b = await app.request('/agent/execute', body, 'qa-agent', headers);
  assert.equal(a.status, 200); assert.deepEqual(a, b);
  assert.equal(app.forwarded.length, 1);
  const conflict = await app.request('/agent/execute', { action: 'execute_sql', payload: { sql: 'SELECT 1' } }, 'qa-agent', headers);
  assert.equal(conflict.status, 409);
  assert.equal(app.forwarded.length, 1);
  assert.equal((await app.request('/agent/execute', body, 'qa-agent', { 'idempotency-key': '' })).status, 400);
});

test('duplicate writes cannot create a second approval or execute before review', async (t) => {
  const app = await gateway({ APPROVAL_TIMEOUT_MS: '1000' }); t.after(() => app.close());
  const body = { action: 'spin_up_dev_vm' };
  const headers = { 'idempotency-key': 'duplicate-pending-write' };
  const first = app.request('/agent/execute', body, 'qa-agent', headers);
  for (let i = 0; i < 50; i++) {
    const pending = await app.request('/approvals/pending', undefined, 'qa-reviewer');
    if (pending.data.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = await app.request('/agent/execute', body, 'qa-agent', headers);
  assert.equal(second.status, 409);
  assert.equal(second.data.status, 'IN_PROGRESS');
  assert.equal((await app.request('/approvals/pending', undefined, 'qa-reviewer')).data.length, 1);
  assert.equal((await first).status, 408);
  assert.equal(app.forwarded.length, 0);
});
