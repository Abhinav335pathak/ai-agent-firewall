'use strict';

const { createHash, randomUUID } = require('node:crypto');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

class RequestStore {
  constructor(pool) {
    this.pool = pool ? { query: async (...args) => {
      try { return await pool.query(...args); }
      catch { const error = new Error('Request tracking unavailable; inspect audit before retrying'); error.status = 503; throw error; }
    } } : null;
    this.memory = new Map();
  }
  async init() {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS action_requests (
      agent TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      request_id TEXT NOT NULL, state TEXT NOT NULL, response JSONB,
      PRIMARY KEY (agent, key)
    ); UPDATE action_requests SET state = 'interrupted' WHERE state = 'pending';`);
  }
  async reserve(agent, key, body) {
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
    const id = randomUUID();
    let existing;
    if (this.pool) {
      const result = await this.pool.query(`INSERT INTO action_requests(agent,key,fingerprint,request_id,state)
        VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING RETURNING request_id`, [agent, key, fingerprint, id]);
      if (result.rowCount) return { id };
      existing = (await this.pool.query('SELECT * FROM action_requests WHERE agent=$1 AND key=$2', [agent, key])).rows[0];
    } else {
      existing = this.memory.get(JSON.stringify([agent, key]));
      if (!existing) { this.memory.set(JSON.stringify([agent, key]), { fingerprint, request_id: id, state: 'pending' }); return { id }; }
    }
    if (existing.fingerprint !== fingerprint) return { conflict: true };
    if (existing.state === 'complete') return { replay: existing.response };
    return { pending: true, id: existing.request_id, interrupted: existing.state === 'interrupted' };
  }
  async complete(agent, key, status, body) {
    const response = { status, body };
    if (this.pool) await this.pool.query(`UPDATE action_requests SET state='complete', response=$3 WHERE agent=$1 AND key=$2`, [agent, key, JSON.stringify(response)]);
    else Object.assign(this.memory.get(JSON.stringify([agent, key])), { state: 'complete', response });
  }
}

module.exports = { RequestStore };
