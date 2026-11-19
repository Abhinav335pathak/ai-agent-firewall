'use strict';

/**
 * "Company API server" - stands in for a company's real internal backend.
 * It talks to a REAL PostgreSQL database and performs REAL SQL, including a real
 * DROP TABLE, so the demo stakes are visible. It lives on a private Docker network:
 * only the firewall can reach it, and it requires the firewall's internal token.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 4000);
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || '';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const SEED_SQL = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Seed on a brand-new database only (iam_roles missing). Restarts never wipe state. */
async function ensureSeeded(retries = 20) {
  for (let i = 1; i <= retries; i++) {
    try {
      const { rows } = await pool.query("SELECT to_regclass('public.iam_roles') AS t");
      if (!rows[0].t) {
        await pool.query(SEED_SQL);
        console.log('[company-api] fresh database seeded');
      }
      return;
    } catch (err) {
      console.warn(`[company-api] database not ready (${i}/${retries}): ${err.message}`);
      await sleep(2000);
    }
  }
  throw new Error('database never became ready');
}

async function snapshot() {
  let customers = null; // null = the table no longer exists
  try {
    customers = (await pool.query('SELECT id, name, email, plan FROM customers ORDER BY id')).rows;
  } catch (err) {
    if (err.code !== '42P01') throw err; // 42P01 = undefined_table
  }
  const cloudResources = (await pool.query('SELECT id, resource_name, status FROM cloud_resources ORDER BY id')).rows;
  const iamRoles = (await pool.query('SELECT username, role FROM iam_roles ORDER BY username')).rows;
  return { customers, cloudResources, iamRoles, checkedAt: new Date().toISOString() };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.get(
  '/health',
  wrap(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  })
);

// Everything below requires the firewall's internal credential.
app.use((req, res, next) => {
  if (!INTERNAL_TOKEN) return next();
  if (safeEqual(req.get('x-internal-token') || '', INTERNAL_TOKEN)) return next();
  return res.status(401).json({ error: 'internal credential required' });
});

app.get('/status', wrap(async (req, res) => res.json(await snapshot())));

app.post('/logs/read', (req, res) => {
  const now = Date.now();
  const line = (ageSec, text) => `${new Date(now - ageSec * 1000).toISOString()} ${text}`;
  res.json({
    logs: [
      line(300, '[INFO]  prod-web-server-01 health check ok'),
      line(180, '[WARN]  p95 latency 840ms on /api/orders'),
      line(60, '[ERROR] connection pool exhausted (recovered)'),
      line(5, '[INFO]  autoscaler: no action needed'),
    ],
  });
});

app.post(
  '/vm/spin-up',
  wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cloud_resources');
    const name = `dev-worker-${String(rows[0].n + 1).padStart(2, '0')}`;
    const ins = await pool.query(
      "INSERT INTO cloud_resources (resource_name, status) VALUES ($1, 'RUNNING') RETURNING id, resource_name, status",
      [name]
    );
    res.json({ created: ins.rows[0] });
  })
);

app.post(
  '/iam/elevate',
  wrap(async (req, res) => {
    const r = await pool.query("UPDATE iam_roles SET role = 'SUPER_ADMIN' WHERE username = 'ai-agent' RETURNING username, role");
    res.json({ updated: r.rows[0] || null });
  })
);

// The dangerous one: a real DROP TABLE.
app.delete(
  '/db/customers',
  wrap(async (req, res) => {
    await pool.query('DROP TABLE IF EXISTS customers');
    res.json({ dropped: 'customers' });
  })
);

app.post(
  '/admin/reset',
  wrap(async (req, res) => {
    await pool.query(SEED_SQL);
    res.json({ reset: true, snapshot: await snapshot() });
  })
);

app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[company-api] error:', err.message);
  res.status(500).json({ error: err.message });
});

ensureSeeded()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`[company-api] listening on :${PORT}`));
    const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })
  .catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  });
