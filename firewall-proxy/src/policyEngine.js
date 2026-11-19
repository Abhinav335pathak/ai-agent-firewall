'use strict';

/**
 * Policy engine: loads policies.yaml, validates it, evaluates actions and
 * hot-reloads when the file changes.
 *
 * Deterministic by design - no ML. The same input always gives the same verdict,
 * which is exactly what you want from a security control.
 */

const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');

const DECISIONS = ['ALLOW', 'BLOCK', 'REQUIRE_APPROVAL'];
const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ACTION_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Returns a list of human-readable problems. Empty list = valid. */
function validatePolicy(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['policy must be a YAML mapping'];
  }

  const errors = [];

  if (!['BLOCK', 'REQUIRE_APPROVAL'].includes(doc.default_decision)) {
    errors.push(
      '"default_decision" must be BLOCK or REQUIRE_APPROVAL (never ALLOW - unknown actions must fail closed)'
    );
  }

  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    errors.push('"rules" must be a non-empty list');
    return errors;
  }

  const seen = new Set();
  doc.rules.forEach((rule, i) => {
    const where = `rules[${i}]`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${where}: must be a mapping`);
      return;
    }
    if (typeof rule.action !== 'string' || !ACTION_RE.test(rule.action)) {
      errors.push(`${where}: "action" must be a snake_case string`);
    } else if (seen.has(rule.action)) {
      errors.push(`${where}: duplicate action "${rule.action}"`);
    } else {
      seen.add(rule.action);
    }
    if (!RISKS.includes(rule.risk)) {
      errors.push(`${where}: "risk" must be one of ${RISKS.join(', ')}`);
    }
    if (!DECISIONS.includes(rule.decision)) {
      errors.push(`${where}: "decision" must be one of ${DECISIONS.join(', ')}`);
    }
    if (['HIGH', 'CRITICAL'].includes(rule.risk) && rule.decision === 'ALLOW') {
      errors.push(`${where}: ${rule.risk}-risk action "${rule.action}" must not be ALLOW`);
    }
  });

  return errors;
}

class PolicyError extends Error {
  constructor(errors) {
    super(`Invalid policy: ${errors.join('; ')}`);
    this.name = 'PolicyError';
    this.errors = errors;
  }
}

class PolicyEngine {
  /**
   * @param {string} file  path to policies.yaml
   * @param {{onReload?: Function, onError?: Function}} [hooks]
   */
  constructor(file, hooks = {}) {
    this.file = file;
    this.onReload = hooks.onReload || (() => {});
    this.onError = hooks.onError || (() => {});
    this.rules = new Map();
    this.defaultDecision = 'REQUIRE_APPROVAL';
    this.version = null;
    this.loadedAt = null;
    this.mtimeMs = 0;
    this.lastError = null;
    this.load(); // throws on an invalid initial policy -> fail closed (container will not become healthy)
  }

  load() {
    const text = fs.readFileSync(this.file, 'utf8');
    const doc = yaml.load(text);
    const errors = validatePolicy(doc);
    if (errors.length) throw new PolicyError(errors);

    this.rules = new Map(doc.rules.map((r) => [r.action, r]));
    this.defaultDecision = doc.default_decision;
    this.version = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
    this.loadedAt = new Date().toISOString();
    this.mtimeMs = fs.statSync(this.file).mtimeMs;
    this.lastError = null;
  }

  /** Reload if the file changed. A broken edit never replaces a good policy. */
  checkAndReload() {
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch (err) {
      this.lastError = `cannot read policy file: ${err.message}`;
      return false;
    }
    if (mtime === this.mtimeMs) return false;

    try {
      this.load();
      this.onReload(this.summary());
      return true;
    } catch (err) {
      this.mtimeMs = mtime; // do not retry the same broken file every call
      this.lastError = err.message;
      this.onError(err);
      return false;
    }
  }

  /** @returns {{decision: string, risk: string, matched: boolean, description?: string}} */
  evaluate(action) {
    this.checkAndReload();
    const rule = this.rules.get(action);
    if (!rule) {
      return { decision: this.defaultDecision, risk: 'UNKNOWN', matched: false };
    }
    return {
      decision: rule.decision,
      risk: rule.risk,
      matched: true,
      description: rule.description,
    };
  }

  rulesList() {
    return [...this.rules.values()].map(({ action, risk, decision, description }) => ({
      action,
      risk,
      decision,
      description,
    }));
  }

  summary() {
    return {
      version: this.version,
      loadedAt: this.loadedAt,
      ruleCount: this.rules.size,
      defaultDecision: this.defaultDecision,
      lastError: this.lastError,
    };
  }
}

module.exports = { PolicyEngine, PolicyError, validatePolicy, DECISIONS, RISKS };
