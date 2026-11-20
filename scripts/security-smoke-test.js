#!/usr/bin/env node
'use strict';

// Destructive lifecycle checks are deliberately limited to a named disposable stack.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const exec = promisify(execFile);
const base = process.argv[2] || 'http://localhost';
const project = process.argv[3];
const admin = process.env.ADMIN_TOKEN;
const agent = process.env.AGENT_TOKEN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compose = (...args) => exec('docker', ['compose', '-p', project, ...args], { timeout: 90000, maxBuffer: 1024 * 1024 });

async function request(url, body, token = admin, key = randomUUID()) {
  const res = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: {
    'content-type': 'application/json', authorization: `Bearer ${token || ''}`, 'idempotency-key': key,
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(65000) });
  return { status: res.status, data: await res.json() };
}
const action = (sql, key = randomUUID()) => request('/agent/execute', { action: 'execute_sql', payload: { sql } }, agent, key);
async function ready() {
  for (let i = 0; i < 120; i++) {
    try { if ((await request('/health')).status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('QA stack did not recover');
}
async function pending() {
  for (let i = 0; i < 100; i++) {
    const list = (await request('/approvals/pending')).data;
    if (list.length) return list[0];
    await sleep(20);
  }
  throw new Error('No pending approval appeared');
}

async function main() {
  assert.equal(process.env.ALLOW_SQL_TEST_WRITES, 'true');
  assert.ok(/^ai-agent-firewall-.*(?:-qa|-ci)$/.test(project || ''), 'Use a disposable ai-agent-firewall-*-qa or *-ci project');
  assert.ok(admin && agent, 'Both agent and operator credentials are required');
  await ready();
  for (const url of ['/logs', '/approvals/pending', '/company-status.json']) {
    assert.equal((await request(url, undefined, '')).status, 401);
    assert.equal((await request(url, undefined, agent)).status, 403);
  }
  console.log('PASS anonymous and agent identities cannot read private operator data');
  for (const sql of ['SELECT 1 -- RETURNING ignored\n; DROP TABLE customers', "UPDATE customers SET plan='Pro' RETURNING pg_read_file('/etc/passwd')", 'SELECT pg_sleep(30)', 'SELECT * FROM pg_catalog.pg_authid']) {
    assert.equal((await action(sql)).status, 403);
  }
  console.log('PASS original SQL bypass and restricted function/system-table cases are blocked');
  const email = `security-${randomUUID()}@example.test`;
  const sql = `INSERT INTO customers(name,email,plan) VALUES ('Security QA','${email}','Pro') RETURNING id`;
  const key = randomUUID();
  const first = action(sql, key);
  const entry = await pending();
  await request(`/approval/${entry.id}`, { approved: true });
  const created = await first;
  assert.equal(created.status, 200);
  assert.deepEqual(await action(sql, key), created);
  const count = await action(`SELECT COUNT(*) AS total FROM customers WHERE email='${email}'`);
  assert.equal(Number(count.data.data.rows[0].total), 1);
  assert.equal((await action('SELECT 1', key)).status, 409);
  console.log('PASS completed write retries replay the response without inserting twice');

  // Exercise the active API against real PostgreSQL, including defenses below AST parsing.
  const privateProbe = `const assert=require('node:assert/strict');
  (async()=>{const submit=async(sql,sqlAction)=>{const r=await fetch('http://127.0.0.1:4000/sql/execute',{method:'POST',headers:{'content-type':'application/json','x-internal-token':process.env.INTERNAL_API_TOKEN},body:JSON.stringify({payload:{sql},sqlAction})});return {status:r.status,data:await r.json()};};
  const read=await submit("UPDATE customers SET plan='forbidden'",'sql_read'); assert.equal(read.status,500);assert.match(read.data.error,/read-only/);
  const stacked=await submit('SELECT 1; DROP TABLE customers','sql_write');assert.equal(stacked.status,500);assert.match(stacked.data.error,/multiple commands/);
  const drop=await submit('DROP TABLE customers','sql_write');assert.equal(drop.status,500);assert.match(drop.data.error,/owner|permission/);
  const ok=await submit('SELECT count(*) FROM customers','sql_read');assert.equal(ok.status,200);
  console.log('PASS active API enforces read-only transactions, single statements, restricted role and recovery');
  })().catch(e=>{console.error(e);process.exitCode=1;});`;
  const proof = await compose('exec', '-T', 'company-api-server', 'node', '-e', privateProbe);
  console.log(proof.stdout.trim());

  const crashKey = randomUUID();
  const inFlight = action("UPDATE customers SET plan='must-not-run' WHERE id=1", crashKey).catch(() => null);
  await pending();
  await compose('kill', '-s', 'SIGKILL', 'firewall-proxy');
  await compose('up', '-d', '--wait', '--wait-timeout', '90', 'firewall-proxy');
  await ready(); await inFlight;
  assert.equal((await request('/approvals/pending')).data.length, 0);
  const retry = await action("UPDATE customers SET plan='must-not-run' WHERE id=1", crashKey);
  assert.equal(retry.status, 409);
  const history = (await request('/logs?limit=100')).data;
  assert.ok(history.some((row) => row.decision === 'CANCELLED' && row.detail?.reason?.includes('restarted')));
  console.log('PASS crash/restart cancels pending work and blocks automatic re-execution');

  try {
    await compose('stop', 'audit-db');
    const failed = await action('SELECT 1');
    assert.equal(failed.status, 503);
    console.log('PASS audit outage fails closed with HTTP 503');
  } finally {
    await compose('start', 'audit-db');
    // A restarted process reconnects and recovers any interrupted ledger records.
    await compose('restart', 'firewall-proxy');
    await ready();
  }
  assert.equal((await action('SELECT * FROM customers LIMIT 1')).status, 200);
  console.log('PASS database and gateway recover after audit outage');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
