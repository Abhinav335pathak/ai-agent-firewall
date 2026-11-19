'use strict';

/**
 * AI Agent Firewall - the "brain".
 *
 *   agent --> POST /agent/execute --> [intercept -> classify -> policy -> enforce -> audit]
 *                                              |
 *                         ALLOW ---------------+--> company-api-server (private network)
 *                         BLOCK ---------------+--> 403, nothing is forwarded
 *                         REQUIRE_APPROVAL ----+--> pause, ask a human, forward only if approved
 *
 * The agent has NO network route to the company systems; this process is the only way in.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { PolicyEngine } = require('./policyEngine');
const { AuditStore } = require('./audit');
const { Metrics } = require('./metrics');

const { classifySqlAction, referencedTables } = require('./sqlPolicy');
const { createAccess } = require('./access');
const { RequestStore } = require('./requestStore');

const config = {
  port: Number(process.env.PORT || 3000),
  companyApiUrl: (process.env.COMPANY_API_URL || 'http://company-api-server:4000').replace(/\/$/, ''),
  internalToken: process.env.INTERNAL_API_TOKEN || '',
  policyFile: process.env.POLICY_FILE || '/app/policy/policies.yaml',
  auditDbUrl: process.env.AUDIT_DATABASE_URL || '',
  adminToken: process.env.ADMIN_TOKEN || '',
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 30000),
  allowAuditReset: process.env.ALLOW_AUDIT_RESET === 'true',
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

// What each action does on the company side. The agent never sees these URLs.
const EXECUTORS = {
  read_logs: { method: 'POST', path: '/logs/read' },
  spin_up_dev_vm: { method: 'POST', path: '/vm/spin-up' },
  change_iam_permissions: { method: 'POST', path: '/iam/elevate' },
  delete_prod_db: { method: 'DELETE', path: '/db/customers' },
  sql_read: { method: 'POST', path: '/sql/execute' },
  sql_write: { method: 'POST', path: '/sql/execute' },
};

const ACTION_RE = /^[a-z][a-z0-9_]{0,63}$/;
const nowNs = () => process.hrtime.bigint();
const msSince = (startNs) => Number(nowNs() - startNs) / 1e6;
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function main() {
  // ---------------------------------------------------------------- setup
  const metrics = new Metrics();
  metrics.describe('firewall_decisions_total', 'Final outcome of every agent action');
  metrics.describe('firewall_approvals_requested_total', 'Actions routed to a human');
  metrics.describe('firewall_policy_eval_seconds', 'Time spent evaluating policy per action');
  metrics.describe('firewall_pending_approvals', 'Approvals waiting for a human right now');

  const audit = new AuditStore(config.auditDbUrl);
  await audit.init();
  const requestsStore = new RequestStore(audit.pool);
  await requestsStore.init();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const access = createAccess(process.env, async (req, status) => {
    await audit.record({ id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      agent: req.identity?.id || 'anonymous', action: 'access_denied', target: req.path,
      risk: 'UNKNOWN', policyDecision: 'BLOCK', decision: 'UNAUTHORIZED', detail: { httpStatus: status } });
  });

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false } });

  const engine = new PolicyEngine(config.policyFile, {
    onReload: (s) => {
      console.log(`[policy] reloaded -> version ${s.version} (${s.ruleCount} rules)`);
      io.emit('policy_reloaded', s);
    },
    onError: (err) => console.error(`[policy] reload REJECTED, keeping last good policy: ${err.message}`),
  });
  console.log(`[policy] loaded version ${engine.version} (${engine.rules.size} rules)`);
  setInterval(() => engine.checkAndReload(), 2000).unref();

  app.disable('x-powered-by');
  const dashboard = fs.readFileSync(path.join(__dirname, 'public/dashboard.html'), 'utf8');
  const inlineScript = dashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
  const scriptHash = crypto.createHash('sha256').update(inlineScript).digest('base64');
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${scriptHash}'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://generativelanguage.googleapis.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '10kb' }));
  const requireAdmin = access.requireOperator;
  const requests = new Map();
  app.use((req, res, next) => {
    const key = req.socket.remoteAddress;
    const now = Date.now();
    const record = requests.get(key);
    if (!record || record.until <= now) requests.set(key, { count: 1, until: now + 60000 });
    else if (++record.count > 600) return res.status(429).json({ error: 'Too many requests' });
    if (requests.size > 10000) for (const [id, entry] of requests) if (entry.until <= now) requests.delete(id);
    next();
  });

  // --------------------------------------------------- company-api client
  async function companyRequest(method, urlPath, body) {
    try {
      const r = await fetch(config.companyApiUrl + urlPath, {
        method,
        headers: { 'content-type': 'application/json', 'x-internal-token': config.internalToken },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (err) {
      return { ok: false, status: 502, data: { error: err.message } };
    }
  }

  async function execute(action, target, payload) {
    const ex = EXECUTORS[action];
    if (!ex) {
      return { ok: false, status: 422, data: { error: `no executor registered for "${action}"` } };
    }
    return companyRequest(ex.method, ex.path, {
      target, payload, ...(action.startsWith('sql_') ? { sqlAction: action } : {}),
    });
  }

  // ------------------------------------------------ human-in-the-loop queue
  const pending = new Map();
  const pendingList = () => [...pending.values()].map((p) => p.entry);

  function requestApproval(entry) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(entry.id)) resolve({ approved: false, reason: 'TIMEOUT' });
      }, config.approvalTimeoutMs);
      pending.set(entry.id, {
        entry,
        settle: (approved, reason, by) => {
          clearTimeout(timer);
          resolve({ approved, reason, by });
        },
      });
    });
  }

  function decideApproval(id, approved, by) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    p.settle(approved, approved ? 'HUMAN_APPROVED' : 'HUMAN_REJECTED', by);
    return true;
  }

  function cancelPending(id, reason) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.settle(false, reason);
  }

  // ------------------------------------------------------------- recording
  async function finalize(base, decision, extra = {}) {
    const entry = {
      ...base,
      decision,
      latencyMs: Number(msSince(base._startNs).toFixed(2)),
      ...extra,
      detail: { ...base.detail, ...extra.detail },
    };
    delete entry._startNs;
    metrics.inc('firewall_decisions_total', { decision });
    await audit.record(entry);
    io.emit('action_event', entry);
    return entry;
  }

  // ------------------------------------------------------- core endpoint
  app.post('/agent/execute', access.requireIdentity, wrap(async (req, res) => {
    const startNs = nowNs();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawAction = body.action;

    if (typeof rawAction !== 'string' || !ACTION_RE.test(rawAction)) {
      await audit.record({ id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        agent: req.identity.id, action: 'invalid_action', target: null, risk: 'UNKNOWN',
        policyDecision: 'BLOCK', decision: 'INVALID', detail: { reason: 'invalid action label' } });
      return res.status(400).json({ status: 'INVALID', error: '"action" must be a snake_case string' });
    }

    const agent = req.identity.id;
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};

    // Always inspect SQL AST for execute_sql, any sql_* action, or any payload containing sql
    const isSql = rawAction === 'execute_sql' || rawAction.startsWith('sql_') || typeof payload.sql === 'string';
    const action = isSql ? classifySqlAction(payload.sql) : rawAction;
    const target = isSql ? clip(payload.sql || body.target, 128) : clip(body.target, 128);

    if (req.identity.role === 'agent') {
      const actions = req.identity.actions || ['read_logs', 'spin_up_dev_vm', 'change_iam_permissions', 'execute_sql'];
      const tables = req.identity.tables || ['customers', 'cloud_resources', 'iam_roles'];
      const allowedAction = actions.includes(action) || (isSql && actions.includes('execute_sql'));
      const allowedTables = !isSql || action === 'sql_destructive' || referencedTables(payload.sql).every((table) => tables.includes(table));
      if (!allowedAction || !allowedTables) {
        await audit.record({ id: crypto.randomUUID(), timestamp: new Date().toISOString(),
          agent, action, target, risk: 'UNKNOWN', policyDecision: 'BLOCK', decision: 'FORBIDDEN',
          detail: { reason: 'outside agent scope', ...(isSql ? { sql: payload.sql } : {}) } });
        return res.status(403).json({ status: 'FORBIDDEN', error: 'Outside this agent identity scope' });
      }
    }

    // 1) INTERCEPT + 2) CLASSIFY + 3) CHECK POLICY
    const evalStart = nowNs();
    const verdict = engine.evaluate(action);
    const evalSeconds = Number(nowNs() - evalStart) / 1e9;
    metrics.observe('firewall_policy_eval_seconds', evalSeconds);

    const key = req.get('idempotency-key');
    if (!key || !/^[a-zA-Z0-9_.:-]{8,128}$/.test(key)) {
      await audit.record({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), agent, action, target,
        risk: verdict.risk, policyDecision: 'BLOCK', decision: 'INVALID', detail: { reason: 'valid Idempotency-Key required' } });
      return res.status(400).json({ status: 'INVALID', error: 'Idempotency-Key header (8-128 safe characters) is required' });
    }
    const reservation = await requestsStore.reserve(agent, key, { action, target, payload });
    if (reservation.conflict) return res.status(409).json({ status: 'CONFLICT', error: 'Idempotency key already belongs to a different request' });
    if (reservation.replay) return res.status(reservation.replay.status).json(reservation.replay.body);
    if (reservation.pending) return res.status(409).json({ status: reservation.interrupted ? 'EXECUTION_UNCONFIRMED' : 'IN_PROGRESS', id: reservation.id, reason: 'Do not submit again with a new key; inspect the audit trail first' });
    const respond = async (status, data) => {
      await requestsStore.complete(agent, key, status, data);
      return res.status(status).json(data);
    };
    const base = {
      id: reservation.id,
      timestamp: new Date().toISOString(),
      agent,
      action,
      target,
      risk: verdict.risk,
      policyDecision: verdict.decision,
      policyEvalMs: Number((evalSeconds * 1000).toFixed(3)),
      _startNs: startNs,
      detail: { policyVersion: engine.version, ...(isSql ? { sql: payload.sql } : {}) },
    };

    await finalize(base, 'INTERCEPTED');

    // 4) DECIDE + ENFORCE
    async function runAndRespond(label) {
      const current = engine.evaluate(action);
      if (current.decision === 'BLOCK' || (verdict.decision === 'ALLOW' && current.decision !== 'ALLOW')) {
        await finalize(base, 'BLOCKED', { detail: { reason: 'policy changed before execution' } });
        return respond(403, { status: 'BLOCKED', id: base.id, reason: 'Policy changed before execution' });
      }
      await finalize(base, 'EXECUTING');
      const result = await execute(action, target, payload);
      if (!result.ok) {
        await finalize(base, 'ERROR', {
          detail: {
            upstreamStatus: result.status,
            error: result.data.error,
            ...(isSql ? { sql: payload.sql } : {}),
          },
        });
        return respond(502, { status: 'ERROR', id: base.id, error: result.data.error || 'upstream failure' });
      }
      await finalize(base, label, isSql ? { detail: { sql: payload.sql } } : {});
      return respond(200, {
        status: label === 'ALLOWED' ? 'ALLOWED' : 'APPROVED',
        id: base.id,
        classifiedAction: action,
        risk: base.risk,
        data: result.data,
      });
    }

    if (verdict.decision === 'ALLOW') {
      return runAndRespond('ALLOWED');
    }

    if (verdict.decision === 'BLOCK') {
      await finalize(base, 'BLOCKED', { detail: { reason: 'policy', sql: payload.sql || null } });
      return respond(403, {
        status: 'BLOCKED',
        id: base.id,
        classifiedAction: action,
        risk: base.risk,
        reason: `Action "${action}" is blocked by firewall policy (risk ${base.risk})`,
      });
    }

    // REQUIRE_APPROVAL -> hold the agent's request open until a human decides
    const pendingEntry = {
      id: base.id,
      timestamp: base.timestamp,
      agent,
      action,
      target,
      ...(isSql ? { sql: payload.sql, payload } : {}),
      risk: base.risk,
      policyDecision: base.policyDecision,
      decision: 'PENDING_APPROVAL',
      timeoutMs: config.approvalTimeoutMs,
      expiresAt: new Date(Date.now() + config.approvalTimeoutMs).toISOString(),
    };

    res.on('close', () => {
      if (!res.writableFinished) cancelPending(base.id, 'AGENT_DISCONNECTED');
    });

    await finalize(base, 'PENDING_APPROVAL');
    const waiter = requestApproval(pendingEntry);
    metrics.inc('firewall_approvals_requested_total');
    io.emit('approval_required', pendingEntry);

    const outcome = await waiter;

    if (['RESET', 'SHUTDOWN'].includes(outcome.reason)) {
      await finalize(base, 'CANCELLED', { detail: { reason: outcome.reason } });
      return respond(409, { status: 'CANCELLED', id: base.id });
    }
    if (outcome.reason === 'AGENT_DISCONNECTED') {
      await finalize(base, 'CANCELLED', {
        detail: { reason: 'agent disconnected', ...(isSql ? { sql: payload.sql } : {}) },
      });
      await requestsStore.complete(agent, key, 409, { status: 'CANCELLED', id: base.id });
      return undefined;
    }
    if (outcome.reason === 'TIMEOUT') {
      await finalize(base, 'TIMED_OUT', {
        detail: { reason: 'no human decision - auto-denied', ...(isSql ? { sql: payload.sql } : {}) },
      });
      return respond(408, { status: 'TIMED_OUT', id: base.id, reason: 'No human approval in time - auto-denied' });
    }
    if (!outcome.approved) {
      await finalize(base, 'REJECTED_BY_HUMAN', {
        detail: { decidedBy: outcome.by || null, ...(isSql ? { sql: payload.sql } : {}) },
      });
      return respond(403, { status: 'REJECTED', id: base.id, reason: 'Rejected by a human reviewer' });
    }
    base.detail.reviewedBy = outcome.by;
    return runAndRespond('APPROVED_BY_HUMAN');
  }));

  // ---------------------------------------------------- approval endpoints
  app.post('/approval/:id', requireAdmin, (req, res) => {
    const approved = req.body && req.body.approved === true;
    if (!decideApproval(req.params.id, approved, req.identity.id)) {
      return res.status(404).json({ error: 'No pending request with that id (already decided or expired)' });
    }
    return res.json({ status: 'Decision recorded', id: req.params.id, approved });
  });

  app.get('/approvals/pending', requireAdmin, (req, res) => res.json(pendingList()));

  // ------------------------------------------------------------ read APIs
  app.get('/health', (req, res) =>
    res.json({
      status: 'ok',
      policy: engine.summary(),
      auditDb: audit.ok,
      pendingApprovals: pending.size,
    })
  );

  app.get('/policy', requireAdmin, (req, res) => res.json({ ...engine.summary(), rules: engine.rulesList() }));

  app.get('/logs', requireAdmin, wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json(await audit.recent(limit));
  }));

  app.get('/metrics', access.requireMetrics, (req, res) => {
    res.type('text/plain; version=0.0.4').send(metrics.render({ firewall_pending_approvals: pending.size }));
  });

  app.get('/company-status.json', requireAdmin, wrap(async (req, res) => {
    const r = await companyRequest('GET', '/status');
    res.status(r.ok ? 200 : 502).json(r.ok ? r.data : { error: r.data.error || 'company api unreachable' });
  }));

  app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false }));
  app.get('/company-status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
  app.get('/agent-console', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agent-console.html')));
  app.get('/', (req, res) => res.redirect('/company-status'));

  // ------------------------------------------------------------- demo reset
  app.post('/admin/reset', requireAdmin, wrap(async (req, res) => {
    for (const id of [...pending.keys()]) {
      const p = pending.get(id);
      pending.delete(id);
      p.settle(false, 'RESET');
    }
    if (config.allowAuditReset) await audit.reset();
    const r = await companyRequest('POST', '/admin/reset');
    await audit.record({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), agent: req.identity.id,
      action: 'admin_reset', target: 'demo', risk: 'HIGH', policyDecision: 'REQUIRE_APPROVAL',
      decision: r.ok ? 'RESET_COMPLETED' : 'RESET_FAILED', detail: { reviewedBy: req.identity.id, auditCleared: config.allowAuditReset } });
    io.emit('feed_reset');
    res.status(r.ok ? 200 : 502).json({
      status: r.ok ? 'RESET_OK' : 'RESET_FAILED',
      auditCleared: config.allowAuditReset,
      company: r.data,
    });
  }));

  // ------------------------------------------------------- error handling
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'invalid request body' });
    }
    console.error('[error]', err);
    return res.status(500).json({ error: 'internal error' });
  });

  // ------------------------------------------------------ realtime (Android)
  io.use((socket, next) => {
    socket.identity = access.identify(socket.handshake.auth?.token);
    if (socket.identity?.role !== 'operator') return next(new Error('Operator authentication required'));
    next();
  });
  io.on('connection', async (socket) => {
    try { socket.emit('history', await audit.recent(50)); } catch { socket.disconnect(true); return; }
    socket.emit('pending', pendingList());

    socket.on('approval_decision', (msg, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const ok = msg && typeof msg.id === 'string' && decideApproval(msg.id, msg.approved === true, socket.identity.id);
      return reply({ ok: Boolean(ok) });
    });
  });

  // ---------------------------------------------------------------- start
  server.listen(config.port, () => console.log(`[firewall] listening on :${server.address().port}`));

  const shutdown = (signal) => {
    console.log(`[firewall] ${signal} received, shutting down`);
    for (const id of [...pending.keys()]) cancelPending(id, 'SHUTDOWN');
    io.close();
    server.close(async () => {
      await audit.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
