'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { gateway } = require('./helpers/gateway');
let app;
before(async () => { app = await gateway(); });
after(async () => { await app?.close(); });

test('HTTP gateway classifies the original SQL, including RETURNING and comments', async () => {
  for (const sql of [
    'SELECT 1 -- RETURNING ignored\n; DROP TABLE customers',
    "UPDATE customers SET plan = 'Pro' RETURNING pg_read_file('/etc/passwd')",
    'SELECT 1; SELECT 2', 'DROP TABLE customers', 'SELECT * INTO backup FROM customers',
    'SELECT pg_sleep(30)', "SELECT set_config('application_name', 'changed', false)",
    'SELECT * FROM pg_catalog.pg_authid',
  ]) {
    const before = app.forwarded.length;
    const response = await app.request('/agent/execute', { action: 'sql_read', payload: { sql } });
    assert.equal(response.status, 403, sql);
    assert.equal(response.data.classifiedAction, 'sql_destructive');
    assert.equal(app.forwarded.length, before, 'blocked SQL must never reach the API');
  }
});

test('HTTP gateway forwards a valid SELECT unchanged', async () => {
  const sql = '/* RETURNING text in comment */ SELECT name FROM customers;';
  const response = await app.request('/agent/execute', { action: 'execute_sql', payload: { sql } });
  assert.equal(response.status, 200);
  assert.equal(app.forwarded.at(-1).body.payload.sql, sql);
});

test('caller action labels cannot turn a SQL UPDATE into an automatic read', async () => {
  const before = app.forwarded.length;
  const response = await app.request('/agent/execute', { action: 'sql_read', payload: { sql: "UPDATE customers SET plan = 'Pro' WHERE id = 1" } });
  assert.equal(response.status, 408);
  assert.equal(app.forwarded.length, before);
});
