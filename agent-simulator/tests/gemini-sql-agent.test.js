'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('../gemini-sql-agent');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

function fixture({ sql = 'SELECT * FROM customers', status = 200, summaryFails = false, calls, geminiFails = false, firewallFails = false } = {}) {
  const requests = [];
  let geminiCalls = 0;
  const modelMessage = { role: 'model', parts: calls || [{ thoughtSignature: 'preserve-me', functionCall: { id: 'call-1', name: 'execute_sql', args: { sql } } }] };
  const verdict = { status: status === 403 ? 'BLOCKED' : 'ALLOWED', classifiedAction: status === 403 ? 'sql_destructive' : 'sql_read', data: { rows: [] } };
  const turn = createAgent({ apiKey: 'test-key', sleepImpl: async () => {}, fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      if (geminiFails || (summaryFails && JSON.parse(options.body).toolConfig.functionCallingConfig.mode === 'NONE')) return response({}, 503);
      return response({ candidates: [{ content: geminiCalls === 1 ? modelMessage : { role: 'model', parts: [{ text: 'Here is the actual result.' }] } }] });
    }
    if (firewallFails) throw new Error('Firewall unavailable');
    return response(verdict, status);
  } });
  return { turn, requests, verdict };
}

test('API key is required', () => {
  assert.throws(() => createAgent({}), /GEMINI_API_KEY/);
});

test('SQL goes through localhost firewall; API key stays in header and tool metadata survives', async () => {
  const { turn, requests } = fixture();
  const history = [];
  const result = await turn('List customers', history);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.text, 'Here is the actual result.');
  assert.equal(requests[1].url, 'http://localhost/agent/execute');
  assert.equal(requests[1].body.action, 'execute_sql');
  assert.equal(requests[1].headers['x-goog-api-key'], undefined);
  assert.equal(requests[0].headers['x-goog-api-key'], 'test-key');
  assert.equal(requests[0].url.includes('test-key'), false);
  assert.equal(requests[2].body.contents[1].parts[0].thoughtSignature, 'preserve-me');
  assert.equal(requests[2].body.contents[2].parts[0].functionResponse.id, 'call-1');
  assert.equal(requests[2].body.toolConfig.functionCallingConfig.mode, 'NONE');
});

test('blocked SQL is reported without retrying execution', async () => {
  const { turn, requests } = fixture({ sql: 'DROP TABLE customers', status: 403 });
  const result = await turn('Delete customers', []);
  assert.equal(result.verdict.status, 'BLOCKED');
  assert.equal(result.httpStatus, 403);
  assert.equal(requests.filter((r) => r.url.includes('/agent/execute')).length, 1);
});

test('summary failure still returns the real firewall result', async () => {
  const { turn, verdict } = fixture({ summaryFails: true });
  const history = [];
  const result = await turn('List customers', history);
  assert.equal(result.text, JSON.stringify(verdict));
  assert.equal(history.length, 3);
});

for (const calls of [
  [],
  [{ functionCall: { name: 'other_tool', args: { sql: 'SELECT 1' } } }],
  [{ functionCall: { name: 'execute_sql', args: { sql: null } } }],
  [{ functionCall: { name: 'execute_sql', args: { sql: 'SELECT 1' } } }, { functionCall: { name: 'execute_sql', args: { sql: 'SELECT 2' } } }],
]) {
  test(`invalid tool calls never reach the firewall: ${JSON.stringify(calls)}`, async () => {
    const { turn, requests } = fixture({ calls });
    const history = [{ role: 'user', parts: [{ text: 'Previous turn' }] }];
    await assert.rejects(turn('List customers', history), /exactly one execute_sql/);
    assert.equal(requests.length, 1);
    assert.equal(history.length, 1);
  });
}

test('Gemini failures leave history usable for the next prompt', async () => {
  const { turn } = fixture({ geminiFails: true });
  const history = [];
  await assert.rejects(turn('List customers', history), /Gemini API HTTP 503/);
  assert.deepEqual(history, []);
});

test('firewall connection failures remove the incomplete tool turn', async () => {
  const { turn } = fixture({ firewallFails: true });
  const history = [];
  await assert.rejects(turn('List customers', history), /Firewall unavailable/);
  assert.deepEqual(history, []);
});

function retryFixture(handler) {
  const requests = [];
  const waits = [];
  let executions = 0;
  const turn = createAgent({ apiKey: 'test-key', model: 'primary', fallbackModels: ['backup'],
    sleepImpl: async (ms) => waits.push(ms), fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.includes('/agent/execute')) {
        executions++;
        return response({ status: 'ALLOWED', data: { rows: [{ total: 3 }] } });
      }
      const model = url.match(/models\/([^:]+):/)[1];
      const summary = body.toolConfig.functionCallingConfig.mode === 'NONE';
      requests.push({ model, summary, body });
      const failure = handler({ model, summary, requests });
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      return response({ candidates: [{ content: { role: 'model', parts: summary ? [{ text: 'Three customers.' }]
        : [{ thoughtSignature: `signed-by-${model}`, functionCall: { name: 'execute_sql', args: { sql: 'SELECT COUNT(*) FROM customers' } } }] } }] });
    },
  });
  return { turn, requests, waits, get executions() { return executions; } };
}

test('429 retries once on the same model and honors bounded Retry-After', async () => {
  const f = retryFixture(({ requests }) => requests.length === 1
    ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : null);
  await f.turn('Count customers', []);
  assert.deepEqual(f.requests.map((r) => r.model), ['primary', 'primary', 'primary']);
  assert.deepEqual(f.waits, [2000]);
  assert.equal(f.executions, 1);
});

test('503 exhausts two attempts then uses backup for generation and summary', async () => {
  const f = retryFixture(({ model }) => model === 'primary' ? response({}, 503) : null);
  await f.turn('Count customers', []);
  assert.deepEqual(f.requests.map((r) => r.model), ['primary', 'primary', 'backup', 'backup']);
  assert.deepEqual(f.waits, [800]);
  assert.equal(f.executions, 1);
});

for (const status of [400, 401, 402, 403]) {
  test(`HTTP ${status} stops without retry or fallback`, async () => {
    const f = retryFixture(() => response({}, status));
    const history = [];
    await assert.rejects(f.turn('Count customers', history), new RegExp(`HTTP ${status}`));
    assert.equal(f.requests.length, 1);
    assert.equal(f.executions, 0);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(history, []);
  });
}

test('missing model immediately falls back without a redundant retry', async () => {
  const f = retryFixture(({ model }) => model === 'primary' ? response({}, 404) : null);
  await f.turn('Count customers', []);
  assert.deepEqual(f.requests.map((r) => r.model), ['primary', 'backup', 'backup']);
  assert.deepEqual(f.waits, []);
});

test('network failures retry then fall back before SQL execution', async () => {
  const f = retryFixture(({ model }) => model === 'primary' ? new TypeError('fetch failed') : null);
  await f.turn('Count customers', []);
  assert.equal(f.executions, 1);
  assert.deepEqual(f.waits, [800]);
});

test('all models failing is bounded and preserves history', async () => {
  const f = retryFixture(() => response({}, 503));
  const history = [];
  await assert.rejects(f.turn('Count customers', history), /HTTP 503 \(backup\)/);
  assert.equal(f.requests.length, 4);
  assert.equal(f.executions, 0);
  assert.deepEqual(f.waits, [800, 800]);
  assert.deepEqual(history, []);
});

test('summary failover preserves SQL results without replaying signed tool messages or SQL execution', async () => {
  const f = retryFixture(({ model, summary }) => model === 'primary' && summary ? response({}, 503) : null);
  const history = [];
  const result = await f.turn('Count customers', history);
  assert.equal(result.text, 'Three customers.');
  assert.equal(f.executions, 1);
  const backup = f.requests.find((r) => r.model === 'backup');
  assert.equal(backup.summary, true);
  assert.equal(backup.body.toolConfig.functionCallingConfig.mode, 'NONE');
  assert.equal(JSON.stringify(backup.body.contents).includes('thoughtSignature'), false);
  assert.match(JSON.stringify(backup.body.contents), /total/);
  await f.turn('Count again', history);
  assert.equal(f.requests.at(-1).model, 'backup');
  assert.equal(f.executions, 2);
});
