'use strict';

const crypto = require('node:crypto');
const same = (a, b) => {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function createAccess(env = process.env) {
  const operators = Object.entries(JSON.parse(env.REVIEWER_TOKENS || '{}'))
    .map(([id, token]) => ({ id, token, role: 'operator' }));
  if (env.ADMIN_TOKEN) operators.push({ id: 'admin', token: env.ADMIN_TOKEN, role: 'operator' });
  const agents = Object.entries(JSON.parse(env.AGENT_CREDENTIALS || '{}'))
    .map(([id, settings]) => ({ ...settings, id, role: 'agent' }));
  if (env.AGENT_TOKEN) agents.push({ id: 'demo-agent', token: env.AGENT_TOKEN, role: 'agent' });
  if (!operators.length || !agents.length) throw new Error('Operator and agent credentials must be configured');
  for (const person of [...operators, ...agents]) {
    if (typeof person.token !== 'string' || person.token.length < 8 || !/^[a-zA-Z0-9_.-]{1,64}$/.test(person.id)) throw new Error('Invalid credential configuration');
    if (person.actions && (!Array.isArray(person.actions) || person.actions.some((a) => typeof a !== 'string'))) throw new Error('Invalid agent action scope');
    if (person.tables && (!Array.isArray(person.tables) || person.tables.some((t) => typeof t !== 'string'))) throw new Error('Invalid agent table scope');
  }
  const credentials = [...operators, ...agents, ...(env.METRICS_TOKEN ? [{ id: 'prometheus', token: env.METRICS_TOKEN, role: 'monitor' }] : [])];
  if (new Set(credentials.map((p) => p.token)).size !== credentials.length) throw new Error('Every identity needs a distinct token');
  function identify(token) {
    const person = credentials.find((p) => same(token || '', p.token));
    if (!person) return null;
    const { token: _token, ...identity } = person;
    return identity;
  }
  function middleware(role) {
    return (req, res, next) => {
      const auth = req.get('authorization') || '';
      req.identity = identify(auth.startsWith('Bearer ') ? auth.slice(7) : req.get('x-admin-token'));
      if (!req.identity) return res.status(401).json({ error: 'Authentication required' });
      if (role === 'operator' && req.identity.role !== role) return res.status(403).json({ error: 'Operator access required' });
      if (role === 'metrics' && !['operator', 'monitor'].includes(req.identity.role)) return res.status(403).json({ error: 'Monitoring access required' });
      if (role === 'any' && req.identity.role === 'monitor') return res.status(403).json({ error: 'Agent or operator access required' });
      return next();
    };
  }
  return { identify, requireOperator: middleware('operator'), requireIdentity: middleware('any'), requireMetrics: middleware('metrics') };
}

module.exports = { createAccess };
