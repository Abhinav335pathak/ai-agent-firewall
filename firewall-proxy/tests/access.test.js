'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccess } = require('../src/access');
const { gateway } = require('./helpers/gateway');

test('empty, duplicated and malformed credentials fail closed', () => {
  assert.throws(() => createAccess({}), /must be configured/);
  assert.throws(() => createAccess({ ADMIN_TOKEN: 'same-token', AGENT_TOKEN: 'same-token' }), /distinct/);
  assert.throws(() => createAccess({ ADMIN_TOKEN: 'admin-token', AGENT_CREDENTIALS: '{oops' }));
});

test('named reviewers are identified without returning their secret', () => {
  const access = createAccess({ REVIEWER_TOKENS: '{"reviewer1":"operator-token"}', AGENT_TOKEN: 'agent-token' });
  assert.deepEqual(access.identify('operator-token'), { id: 'reviewer1', role: 'operator' });
  assert.equal(access.identify('invalid'), null);
});

test('anonymous readers, agent impersonation and out-of-scope SQL are rejected by the running server', async (t) => {
  const app = await gateway({ AGENT_CREDENTIALS: JSON.stringify({ restricted: { token: 'restricted-token', actions: ['sql_read'], tables: ['customers'] } }) });
  t.after(() => app.close());
  for (const url of ['/logs', '/approvals/pending', '/company-status.json', '/policy', '/metrics']) {
    assert.equal((await app.request(url, undefined, '')).status, 401, url);
    assert.equal((await app.request(url)).status, 403, url);
    assert.equal((await app.request(url, undefined, 'qa-reviewer')).status, 200, url);
  }
  assert.equal((await app.request('/agent/execute', { action: 'read_logs' }, '')).status, 401);
  const read = await app.request('/agent/execute', { agentId: 'pretend-admin', action: 'execute_sql', payload: { sql: 'SELECT * FROM customers' } }, 'restricted-token');
  assert.equal(read.status, 200);
  const logs = await app.request('/logs', undefined, 'qa-reviewer');
  assert.equal(logs.data[0].agent, 'restricted');
  for (const sql of ['SELECT * FROM iam_roles', "UPDATE customers SET plan = 'Pro'"]) {
    assert.equal((await app.request('/agent/execute', { action: 'execute_sql', payload: { sql } }, 'restricted-token')).status, 403);
  }
});
