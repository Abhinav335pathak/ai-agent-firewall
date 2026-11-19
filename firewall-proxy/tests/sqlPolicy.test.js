'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySqlAction } = require('../src/sqlPolicy');

for (const sql of [
  'SELECT * FROM customers',
  '/* UPDATE customers */ SELECT name FROM public.customers WHERE id = 1;',
  'SELECT COUNT(*), MAX(id) FROM customers',
  'SELECT lower(c.name) FROM customers c ORDER BY c.id LIMIT 5',
  "SELECT 'DROP TABLE customers; DELETE FROM customers' AS example",
  'SELECT * FROM customers WHERE id IN (SELECT id FROM customers)',
]) {
  test(`read: ${sql}`, () => assert.equal(classifySqlAction(sql), 'sql_read'));
}

for (const sql of [
  "INSERT INTO customers(name,email,plan) VALUES ('Demo','demo@example.test','Pro') RETURNING id",
  "UPDATE customers SET plan = 'Pro' WHERE id = 1 RETURNING name",
  "UPDATE customers SET name = upper(name) WHERE id = 1",
]) {
  test(`approval: ${sql}`, () => assert.equal(classifySqlAction(sql), 'sql_write'));
}

for (const sql of [
  null, {}, '', 'SELECT '.repeat(1500), 'not sql',
  'DROP TABLE customers', 'TRUNCATE customers', 'DELETE FROM customers',
  'ALTER TABLE customers ADD COLUMN secret text',
  'SELECT 1; DROP TABLE customers', 'SELECT 1; SELECT 2',
  'SELECT 1 -- RETURNING ignored\n; DROP TABLE customers',
  "UPDATE customers SET plan = 'Pro' RETURNING pg_read_file('/etc/passwd')",
  'SELECT * INTO stolen FROM customers',
  'WITH x AS (DELETE FROM customers RETURNING *) SELECT * FROM x',
  'SELECT * FROM customers FOR UPDATE',
  "SELECT pg_read_file('/etc/passwd')", "SELECT pg_catalog.pg_read_file('/etc/passwd')",
  "SELECT set_config('search_path','private',false)", 'SELECT pg_sleep(30)',
  "SELECT evil.lower('x')", 'SELECT * FROM pg_catalog.pg_authid',
  'SELECT * FROM private.customers', 'SELECT * FROM unrelated_table',
  "UPDATE customers SET name = pg_read_file('/etc/passwd')",
  "INSERT INTO customers(name) SELECT pg_read_file('/etc/passwd')",
  "SELECT 1 UNION SELECT pg_read_file('/etc/passwd')",
]) {
  test(`blocked: ${JSON.stringify(sql).slice(0, 100)}`, () => assert.equal(classifySqlAction(sql), 'sql_destructive'));
}
