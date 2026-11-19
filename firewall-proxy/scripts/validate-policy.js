#!/usr/bin/env node
'use strict';

// CI gate: node scripts/validate-policy.js ../policy/policies.yaml
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validatePolicy } = require('../src/policyEngine');

const file = path.resolve(process.argv[2] || path.join(__dirname, '../../policy/policies.yaml'));

let doc;
try {
  doc = yaml.load(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`FAIL: ${file} is not valid YAML\n${err.message}`);
  process.exit(1);
}

const errors = validatePolicy(doc);
if (errors.length) {
  console.error(`FAIL: ${file} is not a valid policy`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log(`OK: ${file} is valid (${doc.rules.length} rules)`);
