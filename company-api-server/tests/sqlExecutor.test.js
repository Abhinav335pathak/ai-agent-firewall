'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeSql } = require('../sqlExecutor');

function fixture(fail = false) {
  const calls = [];
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === 'object') {
        if (fail) throw new Error('SQL failed');
        return { command: 'SELECT', rowCount: 101, rows: Array.from({ length: 101 }, (_, id) => ({ id })) };
      }
    },
    release() { calls.push('release'); },
  };
  return { calls, pool: { async connect() { calls.push('connect'); return client; } } };
}

test('reads use a read-only transaction, extended protocol and bounded response', async () => {
  const { calls, pool } = fixture();
  const result = await executeSql(pool, 'SELECT * FROM customers', 'sql_read');
  assert.equal(calls[1], 'BEGIN READ ONLY');
  assert.deepEqual(calls[5], { text: 'SELECT * FROM customers', queryMode: 'extended' });
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'release']);
  assert.equal(result.rows.length, 100);
  assert.equal(result.rowCount, 101);
  assert.equal(result.truncated, true);
});

test('approved writes use a write transaction', async () => {
  const { calls, pool } = fixture();
  await executeSql(pool, "UPDATE customers SET plan = 'Pro'", 'sql_write');
  assert.equal(calls[1], 'BEGIN');
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'release']);
});

test('failed statements roll back and release their connection', async () => {
  const { calls, pool } = fixture(true);
  await assert.rejects(executeSql(pool, 'SELECT 1', 'sql_read'), /SQL failed/);
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'release']);
});

test('invalid SQL or classifications never acquire a database connection', async () => {
  const { calls, pool } = fixture();
  for (const [sql, action] of [[null, 'sql_read'], ['', 'sql_read'], ['x'.repeat(8001), 'sql_read'], ['DROP TABLE customers', 'sql_destructive'], ['SELECT 1', undefined]]) {
    await assert.rejects(executeSql(pool, sql, action), { status: 400 });
  }
  assert.deepEqual(calls, []);
});
