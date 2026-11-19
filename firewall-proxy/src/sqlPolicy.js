'use strict';

const { Parser } = require('node-sql-parser');
const parser = new Parser();
const TABLES = new Set(['customers', 'cloud_resources', 'iam_roles']);
const FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'lower', 'upper', 'length', 'coalesce', 'nullif', 'round', 'abs']);

// The demo supports a small SQL subset. Unknown syntax, functions and tables
// fail closed rather than inheriting SELECT's low-risk classification.
function inspect(node, root = false) {
  if (!node || typeof node !== 'object') return true;
  if (Array.isArray(node)) return node.every((item) => inspect(item));
  if (node.with?.length || node.into?.position) return false;
  if (['insert', 'update', 'delete', 'drop', 'alter', 'truncate'].includes(node.type) && !root) return false;
  if (typeof node.table === 'string' && node.type !== 'column_ref') {
    if (!TABLES.has(node.table) || (node.db && node.db !== 'public')) return false;
  }
  if (node.type === 'function' || node.type === 'aggr_func') {
    const name = typeof node.name === 'string' ? node.name : node.name?.name?.map((part) => part.value).join('.');
    const schema = node.name?.schema?.value;
    if (!FUNCTIONS.has(String(name).toLowerCase()) || (schema && schema !== 'pg_catalog')) return false;
  }
  return Object.values(node).every((value) => inspect(value));
}

/** Classify PostgreSQL ASTs, including nested expressions, before policy lookup. */
function classifySqlAction(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 8000) return 'sql_destructive';
  try {
    const parsed = parser.astify(sql, { database: 'PostgresQL' });
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1) return 'sql_destructive';
    const statement = statements[0];
    if (!inspect(statement, true)) return 'sql_destructive';
    if (statement.type === 'select') return 'sql_read';
    if (statement.type === 'insert' || statement.type === 'update') return 'sql_write';
    return 'sql_destructive';
  } catch {
    return 'sql_destructive';
  }
}

module.exports = { classifySqlAction };

function referencedTables(sql) {
  const tables = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.table === 'string' && node.type !== 'column_ref') tables.add(node.table);
    Object.values(node).forEach(walk);
  }
  walk(parser.astify(sql, { database: 'PostgresQL' }));
  return [...tables];
}
module.exports.referencedTables = referencedTables;
