#!/usr/bin/env node
'use strict';

/**
 * Interactive Gemini Text-to-SQL AI Agent.
 * Translates natural-language user/faculty prompts into PostgreSQL queries,
 * sends them to POST /agent/execute for AST policy inspection, and summarizes
 * the real PostgreSQL results (or firewall block) in plain English.
 *
 * Usage:
 *   GEMINI_API_KEY="AIza..." node agent-simulator/gemini-sql-agent.js --url http://3.108.14.197
 */

const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');

const { values: opts } = parseArgs({ options: { url: { type: 'string' } } });
const BASE = (opts.url || process.env.FIREWALL_URL || 'http://3.108.14.197').replace(/\/$/, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AGENT = 'Gemini-SQL-Agent';

if (!GEMINI_API_KEY) {
  console.error('Error: Set GEMINI_API_KEY environment variable first.');
  process.exit(1);
}

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

const tools = [{
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

const MODELS = ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-2.5-flash-lite'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(contents) {
  let lastErr = '';
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents,
            tools,
          }),
        }
      );
      if (res.ok) return res.json();

      lastErr = `HTTP ${res.status} (${model}): ${await res.text()}`;
      // Retry quickly on temporary 503/429 spikes, otherwise fail over to next model
      if (res.status === 503 || res.status === 429) {
        await sleep(800);
        continue;
      }
      break;
    }
  }
  throw new Error(`All Gemini models busy/unavailable -> ${lastErr}`);
}
// async function callGemini(contents) {
//   const res = await fetch(
//     `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
//     {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
//         contents,
//         tools,
//       }),
//     }
//   );
//   if (!res.ok) throw new Error(`Gemini API HTTP ${res.status}: ${await res.text()}`);
//   return res.json();
// }

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];

  console.log(`\n=================================================================`);
  console.log(`  Real Gemini Text-to-SQL Agent  -->  AWS Firewall (${BASE})`);
  console.log(`=================================================================`);
  console.log(`Ask anything in English (or test prompt injection!). Type "exit" to quit.\n`);

  while (true) {
    const prompt = await rl.question('Faculty / User > ');
    if (!prompt.trim()) continue;
    if (prompt.trim().toLowerCase() === 'exit') break;

    history.push({ role: 'user', parts: [{ text: prompt }] });

    try {
      const turn1 = await callGemini(history);
      const modelMsg = turn1.candidates?.[0]?.content;
      const call = modelMsg?.parts?.find((p) => p.functionCall)?.functionCall;

      if (!call) {
        console.log(`\n🤖 Gemini > ${modelMsg?.parts?.[0]?.text || 'No SQL generated.'}\n`);
        if (modelMsg) history.push(modelMsg);
        continue;
      }

      history.push(modelMsg);
      const generatedSql = call.args.sql;
      console.log(`\n🧠 [Gemini SQL]  ${generatedSql}`);
      console.log(`🛡️  [Firewall]    Parsing SQL AST & evaluating policies.yaml...`);

      const fwRes = await fetch(`${BASE}/agent/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: AGENT,
          action: 'execute_sql',
          target: 'company_prod',
          payload: { sql: generatedSql },
        }),
        signal: AbortSignal.timeout(60000),
      });

      const fwData = await fwRes.json().catch(() => ({}));
      const label = fwData.status || 'UNKNOWN';
      console.log(
        `    ${ICON[label] || '❔'} Verdict: ${label} (HTTP ${fwRes.status}) | Rule: ${fwData.classifiedAction || 'n/a'} | Risk: ${fwData.risk || 'n/a'}`
      );

      history.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'execute_sql',
            response: { httpStatus: fwRes.status, firewallResponse: fwData },
          },
        }],
      });

      const turn2 = await callGemini(history);
      const finalMsg = turn2.candidates?.[0]?.content;
      if (finalMsg) history.push(finalMsg);
      console.log(`\n🤖 Gemini > ${finalMsg?.parts?.[0]?.text || JSON.stringify(fwData)}\n`);
    } catch (err) {
      console.error(`\n💥 Error: ${err.message}\n`);
    }
  }

  rl.close();
})();