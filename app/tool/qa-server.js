#!/usr/bin/env node
'use strict';

// Disposable test environment: real firewall, in-memory audit and mock company
// API. No production database, credentials or Docker projects are involved.
const { gateway } = require('../../firewall-proxy/tests/helpers/gateway');

(async () => {
  const app = await gateway({
    PORT: process.env.MOBILE_QA_PORT || '3300',
    APPROVAL_TIMEOUT_MS: process.env.MOBILE_QA_APPROVAL_TIMEOUT_MS || '12000',
    ADMIN_TOKEN: 'qa-reviewer', AGENT_TOKEN: 'qa-agent', INTERNAL_API_TOKEN: 'qa-internal',
    REVIEWER_TOKENS: '', AGENT_CREDENTIALS: '', METRICS_TOKEN: '', ALLOW_AUDIT_RESET: 'true',
  });
  console.log(`Mobile QA firewall ready: ${app.base}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
})().catch((error) => { console.error(error.message); process.exit(1); });
