'use strict';

/**
 * Audit store: every decision (allowed, blocked, approved, rejected, timed out)
 * is written to a dedicated PostgreSQL database that is SEPARATE from the
 * "company" database - so even if the company DB is wiped, the evidence survives.
 *
 * The table is append-only (a trigger rejects UPDATE/DELETE). Falls back to an
 * in-memory buffer when no database is configured (handy for local dev).
 */

const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq             BIGSERIAL PRIMARY KEY,
  request_id      TEXT        NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent           TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  target          TEXT,
  risk            TEXT        NOT NULL,
  policy_decision TEXT        NOT NULL,
  decision        TEXT        NOT NULL,
  latency_ms      DOUBLE PRECISION,
  detail          JSONB
);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuditStore {
  constructor(connectionString) {
    this.memoryOnly = !connectionString;
    this.pool = this.memoryOnly
      ? null
      : new Pool({ connectionString, max: 5, connectionTimeoutMillis: 3000 });
    this.ok = this.memoryOnly;
    this.memory = []; // newest first, capped
  }

  async init(retries = 20) {
    if (this.memoryOnly) {
      console.warn('[audit] AUDIT_DATABASE_URL not set - using in-memory audit log only');
      return;
    }
    let lastErr;
    for (let i = 1; i <= retries; i++) {
      try {
        await this.pool.query(SCHEMA);
        this.ok = true;
        console.log('[audit] connected, schema ready');
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[audit] database not ready (${i}/${retries}): ${err.message}`);
        await sleep(2000);
      }
    }
    throw lastErr;
  }

  async record(entry) {
    this.memory.unshift(entry);
    if (this.memory.length > 200) this.memory.pop();
    if (this.memoryOnly) return;
    try {
      await this.pool.query(
        `INSERT INTO audit_log
           (request_id, ts, agent, action, target, risk, policy_decision, decision, latency_ms, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          entry.id,
          entry.timestamp,
          entry.agent,
          entry.action,
          entry.target,
          entry.risk,
          entry.policyDecision,
          entry.decision,
          entry.latencyMs ?? null,
          entry.detail ? JSON.stringify(entry.detail) : null,
        ]
      );
      this.ok = true;
    } catch (err) {
      this.ok = false;
      console.error('[audit] FAILED TO WRITE AUDIT RECORD:', err.message, JSON.stringify(entry));
    }
  }

  async recent(limit = 50) {
    if (this.memoryOnly) return this.memory.slice(0, limit);
    try {
      const { rows } = await this.pool.query(
        `SELECT request_id, ts, agent, action, target, risk, policy_decision, decision, latency_ms, detail
           FROM audit_log ORDER BY seq DESC LIMIT $1`,
        [limit]
      );
      return rows.map((r) => ({
        id: r.request_id,
        timestamp: r.ts.toISOString(),
        agent: r.agent,
        action: r.action,
        target: r.target,
        risk: r.risk,
        policyDecision: r.policy_decision,
        decision: r.decision,
        latencyMs: r.latency_ms,
        detail: r.detail,
      }));
    } catch (err) {
      console.error('[audit] read failed, serving memory buffer:', err.message);
      return this.memory.slice(0, limit);
    }
  }

  /** Demo-only: wipes the audit trail. TRUNCATE is not blocked by the row trigger. */
  async reset() {
    this.memory.length = 0;
    if (!this.memoryOnly) await this.pool.query('TRUNCATE audit_log');
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = { AuditStore };
