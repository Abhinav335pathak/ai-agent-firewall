'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { io } = require('socket.io-client');
const { gateway } = require('./helpers/gateway');
const html = fs.readFileSync(path.resolve(__dirname, '../src/public/agent-console.html'), 'utf8');
const script = fs.readFileSync(path.resolve(__dirname, '../src/public/agent-console.js'), 'utf8');
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

test('console renders untrusted database fields and full SQL as text without storing credentials', async (t) => {
  const dom = new JSDOM(html, { url: 'http://localhost', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const win = dom.window;
  win.AbortSignal = AbortSignal;
  const hostile = '<img src=x onerror="window.injected=true">';
  const sql = `UPDATE customers SET name = '${hostile}' /* ${'long-query-'.repeat(30)} */`;
  win.fetch = async (url) => response(url === '/company-status.json'
    ? { customers: [{ id: 1, name: hostile }], cloudResources: [] }
    : [{ id: 'qa-id', risk: 'HIGH', sql, target: 'truncated', expiresAt: new Date(Date.now() + 30000).toISOString() }]);
  win.eval(script);
  win.document.getElementById('adminToken').value = 'private-reviewer-token';
  win.document.getElementById('adminToken').dispatchEvent(new win.Event('input'));
  for (let i = 0; i < 50 && !win.document.querySelector('.approval-card'); i++) await pause();
  assert.equal(win.document.querySelector('#custTable img'), null);
  assert.equal(win.document.querySelector('#pendingBox img'), null);
  assert.equal(win.document.querySelector('#pendingBox pre').textContent, sql);
  assert.equal(win.document.querySelector('#custTable').textContent.includes(hostile), true);
  assert.equal(win.localStorage.length, 0);
  assert.equal(win.sessionStorage.length, 0);
});

test('double-click submits SQL once, uses separate token headers and disables tools for summary', async (t) => {
  const dom = new JSDOM(html, { url: 'http://localhost', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const win = dom.window; win.AbortSignal = AbortSignal;
  const requests = [];
  win.fetch = async (url, opts) => {
    requests.push({ url, ...opts });
    if (url.startsWith('https:')) {
      await pause();
      const summary = JSON.parse(opts.body).toolConfig.functionCallingConfig.mode === 'NONE';
      return response({ candidates: [{ content: { role: 'model', parts: summary ? [{ text: 'Read completed.' }]
        : [{ functionCall: { name: 'execute_sql', args: { sql: 'SELECT * FROM customers' } } }] } }] });
    }
    return response({ status: 'ALLOWED', classifiedAction: 'sql_read', risk: 'LOW', data: { rows: [] } });
  };
  win.eval(script);
  for (const [id, value] of [['agentToken', 'private-agent-token'], ['geminiKey', 'private-google-key'], ['promptInput', 'List customers']]) win.document.getElementById(id).value = value;
  win.document.getElementById('runButton').click();
  win.document.getElementById('runButton').click();
  for (let i = 0; i < 100 && win.document.getElementById('runButton').disabled; i++) await pause();
  const executions = requests.filter((r) => r.url === '/agent/execute');
  assert.equal(executions.length, 1);
  assert.match(executions[0].headers['idempotency-key'], /^[a-f0-9]{32}$/);
  assert.equal(executions[0].headers.authorization, 'Bearer private-agent-token');
  assert.equal(executions[0].headers['x-goog-api-key'], undefined);
  assert.equal(requests[0].headers['x-goog-api-key'], 'private-google-key');
  assert.equal(requests[0].url.includes('private-google-key'), false);
  assert.equal(JSON.parse(requests.at(-1).body).toolConfig.functionCallingConfig.mode, 'NONE');
});

test('socket feed rejects anonymous and agent tokens, accepts a reviewer', async (t) => {
  const app = await gateway(); t.after(() => app.close());
  for (const [token, expected] of [['', false], ['qa-agent', false], ['qa-reviewer', true]]) {
    const socket = io(app.base, { auth: { token }, reconnection: false, timeout: 2000 });
    const connected = await new Promise((resolve) => {
      socket.on('connect', () => resolve(true)); socket.on('connect_error', () => resolve(false));
    });
    socket.disconnect();
    assert.equal(connected, expected);
  }
});
