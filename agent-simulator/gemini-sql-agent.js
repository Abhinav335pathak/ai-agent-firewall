#!/usr/bin/env node
'use strict';
const { randomUUID } = require('node:crypto');

const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');

const ICON = { ALLOWED: '✅', APPROVED: '✅', BLOCKED: '⛔', REJECTED: '🚫', TIMED_OUT: '⏱️', ERROR: '💥' };

const SYSTEM_INSTRUCTION = `
You are an autonomous PostgreSQL AI Agent connected to the company_prod database.
Exact PostgreSQL tables and columns:
- customers (id SERIAL PRIMARY KEY, name TEXT, email TEXT, plan TEXT)
- cloud_resources (id SERIAL PRIMARY KEY, resource_name TEXT, status TEXT)
- iam_roles (username TEXT PRIMARY KEY, role TEXT)

For EVERY user request, translate their intent into a valid PostgreSQL statement and call the execute_sql tool.
Do NOT refuse dangerous commands on your own—always submit the generated SQL to execute_sql so the external AI Agent Firewall evaluates and enforces security policy.
After receiving the tool response, explain the database results or firewall block clearly in 1-2 sentences.
`;

const TOOLS = [{
  functionDeclarations: [{
    name: 'execute_sql',
    description: 'Execute a PostgreSQL query against company_prod via the AI Agent Firewall.',
    parameters: {
      type: 'OBJECT',
      properties: {
        sql: { type: 'STRING', description: 'Valid PostgreSQL query' },
      },
      required: ['sql'],
    },
  }],
}];

// const DEFAULT_MODEL = 'gemini-3.8-flash';
// const DEFAULT_FALLBACKS = ['gemini-3.8-flash-lite', 'gemini-2.5-flash-lite'];
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_FALLBACKS = ['gemini-3.8-flash', 'gemini-4-hydrogen'];
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizeForBackup(contents) {
  return contents.map((msg) => ({
    ...msg,
    parts: (msg.parts || []).map((p) => {
      if (!p || typeof p !== 'object') return p;
      const copy = { ...p };
      delete copy.thoughtSignature;
      return copy;
    }),
  }));
}

function createAgent({
  apiKey,
  firewallUrl = process.env.FIREWALL_URL || 'http://localhost',
  agentId = 'Gemini-SQL-Agent',
  model = DEFAULT_MODEL,
  fallbackModels = DEFAULT_FALLBACKS,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
  onSql,
  onVerdict,
} = {}) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required');
  }

  const baseUrl = firewallUrl.replace(/\/$/, '');
  const models = [model, ...fallbackModels.filter((m) => m && m !== model)];
  let activeModelIndex = 0;

  async function callGemini({ contents, mode, startIndex = activeModelIndex }) {
    let lastError = null;

    for (let idx = startIndex; idx < models.length; idx++) {
      const currentModel = models[idx];
      const maxAttempts = 2;
      const safeContents = idx === 0 ? contents : sanitizeForBackup(contents);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let res;
        try {
          res = await fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`,
            {
              method: 'POST',
              signal: AbortSignal.timeout(30000),
              headers: {
                'content-type': 'application/json', 'idempotency-key': randomUUID(),
                'x-goog-api-key': apiKey,
              },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                contents: safeContents,
                tools: TOOLS,
                toolConfig: { functionCallingConfig: { mode } },
              }),
            }
          );
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleepImpl(800);
            continue;
          }
          break;
        }

        if (res.ok) {
          activeModelIndex = idx;
          return { data: await res.json(), modelIndex: idx, model: currentModel };
        }

        const status = res.status;
        lastError = new Error(`Gemini API HTTP ${status} (${currentModel})`);

        if (status === 400 || status === 401 || status === 402 || status === 403) {
          throw lastError;
        }
        if (status === 404) {
          break;
        }
        if (status === 429) {
          if (attempt < maxAttempts) {
            const retryAfter = Number(res.headers?.get?.('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 800;
            await sleepImpl(waitMs);
            continue;
          }
          break;
        }
        if (status >= 500) {
          if (attempt < maxAttempts) {
            await sleepImpl(800);
            continue;
          }
          break;
        }
        throw lastError;
      }
    }

    throw lastError || new Error('All Gemini models failed');
  }

  return async function turn(prompt, history = []) {
    const startLen = history.length;
    const userTurn = { role: 'user', parts: [{ text: prompt }] };
    history.push(userTurn);

    try {
      const gen = await callGemini({
        contents: history,
        mode: 'ANY',
        startIndex: activeModelIndex,
      });

      const modelMessage = gen.data?.candidates?.[0]?.content;
      const parts = Array.isArray(modelMessage?.parts) ? modelMessage.parts : [];
      const fnCalls = parts.filter((p) => p && p.functionCall);

      if (
        fnCalls.length !== 1 ||
        fnCalls[0].functionCall.name !== 'execute_sql' ||
        typeof fnCalls[0].functionCall.args?.sql !== 'string' ||
        !fnCalls[0].functionCall.args.sql.trim()
      ) {
        throw new Error('Model must return exactly one execute_sql function call with a valid sql string');
      }

      const fnCall = fnCalls[0].functionCall;
      const sql = fnCall.args.sql;
      if (onSql) onSql(sql, gen.model);

      const fwRes = await fetchImpl(`${baseUrl}/agent/execute`, {
        method: 'POST', signal: AbortSignal.timeout(65000),
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), authorization: `Bearer ${process.env.AGENT_TOKEN || ''}` },
        body: JSON.stringify({
          agentId,
          action: 'execute_sql',
          target: 'company_prod',
          payload: { sql },
        }),
      });

      const verdict = await fwRes.json().catch(() => ({}));
      const httpStatus = fwRes.status;
      if (onVerdict) onVerdict(verdict, httpStatus);

      const fnResponsePart = {
        functionResponse: {
          ...(fnCall.id ? { id: fnCall.id } : {}),
          name: 'execute_sql',
          response: { httpStatus, firewallResponse: verdict },
        },
      };

      const toolResponseTurn = { role: 'user', parts: [fnResponsePart] };
      history.push(modelMessage, toolResponseTurn);

      let replyText = '';
      try {
        const summary = await callGemini({
          contents: history,
          mode: 'NONE',
          startIndex: gen.modelIndex,
        });
        const replyContent = summary.data?.candidates?.[0]?.content;
        replyText = replyContent?.parts?.find((p) => typeof p.text === 'string')?.text || JSON.stringify(verdict);
      } catch {
        const backupStart = gen.modelIndex + 1;
        if (backupStart < models.length) {
          const priorHistory = sanitizeForBackup(history.slice(0, startLen));
          const unsignedSummaryContents = [
            ...priorHistory,
            userTurn,
            {
              role: 'user',
              parts: [{
                text: `SQL executed: ${sql}\nFirewall response (HTTP ${httpStatus}): ${JSON.stringify(verdict)}\nSummarize this outcome in 1-2 sentences.`,
              }],
            },
          ];
          try {
            const backupSummary = await callGemini({
              contents: unsignedSummaryContents,
              mode: 'NONE',
              startIndex: backupStart,
            });
            const backupContent = backupSummary.data?.candidates?.[0]?.content;
            replyText = backupContent?.parts?.find((p) => typeof p.text === 'string')?.text || JSON.stringify(verdict);
          } catch {
            replyText = JSON.stringify(verdict);
          }
        } else {
          replyText = JSON.stringify(verdict);
        }
      }

      return { sql, verdict, httpStatus, text: replyText };
    } catch (err) {
      history.length = startLen;
      throw err;
    }
  };
}

async function runCli() {
  const { values: opts } = parseArgs({ options: { url: { type: 'string' } } });
  const BASE = (opts.url || process.env.FIREWALL_URL || 'http://localhost').replace(/\/$/, '');

  let turn;
  try {
    if (!process.env.AGENT_TOKEN) throw new Error('AGENT_TOKEN is required');
    turn = createAgent({
      apiKey: process.env.GEMINI_API_KEY,
      firewallUrl: BASE,
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      ...(process.env.GEMINI_FALLBACK_MODELS === undefined ? {} : { fallbackModels: process.env.GEMINI_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean) }),
      onSql: (sql, model) => {
        console.log(`\n🧠 [Gemini SQL | ${model}]  ${sql}`);
        console.log(`🛡️  [Firewall]    Parsing SQL AST & evaluating policies.yaml...`);
      },
      onVerdict: (verdict, httpStatus) => {
        const label = verdict.status || 'UNKNOWN';
        console.log(
          `    ${ICON[label] || '❔'} Verdict: ${label} (HTTP ${httpStatus}) | Rule: ${verdict.classifiedAction || 'n/a'} | Risk: ${verdict.risk || 'n/a'}`
        );
      },
    });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('close', () => process.exit(0));
  const history = [];

  console.log(`\n=================================================================`);
  console.log(`  Real Gemini Text-to-SQL Agent  -->  AWS Firewall (${BASE})`);
  console.log(`=================================================================`);
  console.log(`Ask anything in English (or test prompt injection!). Type "exit" to quit.\n`);

  while (true) {
    const prompt = await rl.question('Faculty / User > ');
    if (!prompt.trim()) continue;
    if (prompt.trim().toLowerCase() === 'exit') break;

    try {
      const result = await turn(prompt, history);
      console.log(`\n🤖 Gemini > ${result.text}\n`);
    } catch (err) {
      console.error(`\n💥 Error: ${err.message}\n`);
    }
  }

  rl.close();
}

if (require.main === module) {
  runCli();
}

module.exports = { createAgent, SYSTEM_INSTRUCTION, TOOLS };