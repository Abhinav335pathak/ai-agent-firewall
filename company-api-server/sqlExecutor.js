'use strict';

/** Run one firewall-reviewed statement on a dedicated transactional connection. */
async function executeSql(pool, sql, action) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 8000 || !['sql_read', 'sql_write'].includes(action)) {
    const error = new Error('A valid SQL query and firewall SQL classification are required');
    error.status = 400;
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query(action === 'sql_read' ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query('SET LOCAL search_path = pg_catalog, public');
    // Extended protocol rejects multiple commands even if the AST parser and
    // PostgreSQL ever disagree about where a statement ends.
    const result = await client.query({ text: sql, queryMode: 'extended' });
    await client.query('COMMIT');
    return { command: result.command, rowCount: result.rowCount, rows: result.rows.slice(0, 100), truncated: result.rows.length > 100 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { executeSql };
