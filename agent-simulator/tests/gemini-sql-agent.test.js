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
  const turn = createAgent({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      if (geminiFails || (geminiCalls === 2 && summaryFails)) return response({}, 503);
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
