'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

async function gateway(extraEnv = {}) {
  const forwarded = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    forwarded.push({ path: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/status'
      ? { customers: [{ name: 'QA' }], cloudResources: [], iamRoles: [] }
      : { command: 'SELECT', rowCount: 1, rows: [{ ok: true }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../src/index.js')], {
    env: { ...process.env, PORT: '0', AUDIT_DATABASE_URL: '',
      ALLOW_IN_MEMORY_AUDIT: 'true',
      POLICY_FILE: path.resolve(__dirname, '../../..', 'policy/policies.yaml'),
      COMPANY_API_URL: `http://127.0.0.1:${upstream.address().port}`,
      ADMIN_TOKEN: 'qa-reviewer', INTERNAL_API_TOKEN: 'qa-internal',
      AGENT_TOKEN: 'qa-agent', APPROVAL_TIMEOUT_MS: '300', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup timed out: ${output}`)), 8000);
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/listening on :(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', (data) => { output += data; });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  }).catch(async (error) => { child.kill(); upstream.close(); throw error; });
  return { base, forwarded, child,
    async request(url, body, token = 'qa-agent', extraHeaders = {}) {
      const res = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      return { status: res.status, data: res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    },
    async close() {
      if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

module.exports = { gateway };
