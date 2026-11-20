'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let count = 0;
function check(file, source) {
  const result = spawnSync(process.execPath, ['--check', ...(source === undefined ? [file] : [])], { input: source, encoding: 'utf8' });
  if (result.status) { console.error(file, result.stderr); process.exit(1); }
  count++;
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) check(file);
    else if (file.endsWith('.html')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) check(file, match[1]);
    }
  }
}
for (const dir of ['firewall-proxy', 'company-api-server', 'agent-simulator', 'scripts']) walk(dir);
console.log(`PASS JavaScript syntax: ${count} files and inline scripts`);
