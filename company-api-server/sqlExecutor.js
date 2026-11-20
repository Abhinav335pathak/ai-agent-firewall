'use strict';

// The API owner manages the demo schema; AI queries never run with that role.
async function prepareSqlRole(pool) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'firewall_sql_executor') THEN
      CREATE ROLE firewall_sql_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO firewall_sql_executor;
  GRANT SELECT, INSERT, UPDATE ON customers, cloud_resources, iam_roles TO firewall_sql_executor;
  GRANT USAGE, SELECT ON SEQUENCE customers_id_seq, cloud_resources_id_seq TO firewall_sql_executor;`);
}

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
    await client.query('SET LOCAL ROLE firewall_sql_executor');
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

module.exports = { executeSql, prepareSqlRole };
