'use strict';

/**
 * Security regression tests for the rulebook. These run in CI on every push / PR.
 * If someone edits policy/policies.yaml and accidentally opens a dangerous hole,
 * the pipeline goes red and nothing is deployed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PolicyEngine, validatePolicy } = require('../src/policyEngine');

const REAL_POLICY = path.resolve(__dirname, '../../policy/policies.yaml');

// ---------------------------------------------------------------- real rulebook
test('real policies.yaml is valid', () => {
  assert.doesNotThrow(() => new PolicyEngine(REAL_POLICY));
});

test('critical: delete_prod_db is BLOCKED', () => {
  const v = new PolicyEngine(REAL_POLICY).evaluate('delete_prod_db');
  assert.equal(v.decision, 'BLOCK');
  assert.equal(v.risk, 'CRITICAL');
});

test('read_logs is allowed automatically', () => {
  assert.equal(new PolicyEngine(REAL_POLICY).evaluate('read_logs').decision, 'ALLOW');
});

test('SQL reads are allowed, writes need approval, destructive SQL is blocked', () => {
  const engine = new PolicyEngine(REAL_POLICY);
  for (const [action, risk, decision] of [
    ['sql_read', 'LOW', 'ALLOW'],
    ['sql_write', 'HIGH', 'REQUIRE_APPROVAL'],
    ['sql_destructive', 'CRITICAL', 'BLOCK'],
  ]) {
    const verdict = engine.evaluate(action);
    assert.equal(verdict.risk, risk);
    assert.equal(verdict.decision, decision);
    assert.equal(verdict.matched, true);
  }
});

test('spin_up_dev_vm and change_iam_permissions need a human', () => {
  const e = new PolicyEngine(REAL_POLICY);
  assert.equal(e.evaluate('spin_up_dev_vm').decision, 'REQUIRE_APPROVAL');
  assert.equal(e.evaluate('change_iam_permissions').decision, 'REQUIRE_APPROVAL');
});

test('unknown actions fail closed (never ALLOW)', () => {
  const v = new PolicyEngine(REAL_POLICY).evaluate('some_new_tool_nobody_reviewed');
  assert.notEqual(v.decision, 'ALLOW');
  assert.equal(v.matched, false);
});

test('invariant: no HIGH/CRITICAL rule is ALLOW in the real policy', () => {
  for (const r of new PolicyEngine(REAL_POLICY).rulesList()) {
    if (['HIGH', 'CRITICAL'].includes(r.risk)) {
      assert.notEqual(r.decision, 'ALLOW', `${r.action} must not be ALLOW`);
    }
  }
});

// -------------------------------------------------------------------- validator
const good = () => ({
  default_decision: 'REQUIRE_APPROVAL',
  rules: [{ action: 'read_logs', risk: 'LOW', decision: 'ALLOW' }],
});

test('validator accepts a minimal good policy', () => {
  assert.deepEqual(validatePolicy(good()), []);
});

test('validator rejects ALLOW on CRITICAL risk', () => {
  const p = good();
  p.rules.push({ action: 'delete_prod_db', risk: 'CRITICAL', decision: 'ALLOW' });
  assert.ok(validatePolicy(p).some((e) => e.includes('must not be ALLOW')));
});

test('validator rejects default_decision ALLOW', () => {
  const p = good();
  p.default_decision = 'ALLOW';
  assert.ok(validatePolicy(p).length > 0);
});

test('validator rejects unknown decision, bad risk, duplicates and bad names', () => {
  const p = good();
  p.rules.push({ action: 'read_logs', risk: 'LOW', decision: 'ALLOW' }); // duplicate
  p.rules.push({ action: 'x', risk: 'LOW', decision: 'MAYBE' }); // bad decision
  p.rules.push({ action: 'y', risk: 'SCARY', decision: 'BLOCK' }); // bad risk
  p.rules.push({ action: 'Bad-Name', risk: 'LOW', decision: 'BLOCK' }); // bad name
  assert.ok(validatePolicy(p).length >= 4);
});

test('validator rejects non-mapping / empty rules', () => {
  assert.ok(validatePolicy(null).length > 0);
  assert.ok(validatePolicy({ default_decision: 'BLOCK', rules: [] }).length > 0);
});

// -------------------------------------------------------------------- hot reload
function tmpPolicy(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const file = path.join(dir, 'policies.yaml');
  fs.writeFileSync(file, content);
  return file;
}

const YAML_A = `default_decision: REQUIRE_APPROVAL
rules:
  - { action: spin_up_dev_vm, risk: MEDIUM, decision: ALLOW }
`;
const YAML_B = `default_decision: REQUIRE_APPROVAL
rules:
  - { action: spin_up_dev_vm, risk: MEDIUM, decision: REQUIRE_APPROVAL }
`;

function bumpMtime(file) {
  const t = new Date(Date.now() + 5000 * (bumpMtime.n = (bumpMtime.n || 0) + 1));
  fs.utimesSync(file, t, t);
}

test('hot reload picks up an edited rule without restart', () => {
  const file = tmpPolicy(YAML_A);
  let reloads = 0;
  const engine = new PolicyEngine(file, { onReload: () => reloads++ });
  assert.equal(engine.evaluate('spin_up_dev_vm').decision, 'ALLOW');

  fs.writeFileSync(file, YAML_B);
  bumpMtime(file);
  assert.equal(engine.evaluate('spin_up_dev_vm').decision, 'REQUIRE_APPROVAL');
  assert.equal(reloads, 1);
});

test('a broken edit never replaces the last good policy', () => {
  const file = tmpPolicy(YAML_B);
  let errors = 0;
  const engine = new PolicyEngine(file, { onError: () => errors++ });

  fs.writeFileSync(file, 'default_decision: ALLOW\nrules: []\n');
  bumpMtime(file);
  assert.equal(engine.evaluate('spin_up_dev_vm').decision, 'REQUIRE_APPROVAL'); // still the old rule
  assert.equal(errors, 1);
  assert.ok(engine.summary().lastError);
});

test('an invalid initial policy refuses to start (fail closed)', () => {
  const file = tmpPolicy('default_decision: ALLOW\nrules: []\n');
  assert.throws(() => new PolicyEngine(file), /Invalid policy/);
});
