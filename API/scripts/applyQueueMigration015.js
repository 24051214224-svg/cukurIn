require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/database");

(async () => {
  const migrationName = "015_add_queue_lifecycle.sql";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const target = await client.query(
      "SELECT current_database() AS db"
    );
    const recorded = await client.query(
      "SELECT migration_name FROM schema_migrations WHERE migration_name = $1",
      [migrationName]
    );
    const lifecycleColumns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'queues'
         AND column_name = ANY($1::text[])`,
      [["started_at", "completed_at", "cancelled_at"]]
    );
    const index = await client.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'queues'
         AND indexname = 'idx_queues_barber_date_status'`
    );

    const needsSql =
      lifecycleColumns.rows.length !== 3 ||
      index.rows.length === 0 ||
      recorded.rows.length === 0;

    let applied = false;
    if (needsSql) {
      const sql = fs.readFileSync(
        path.join(__dirname, "..", "database", "migrations", migrationName),
        "utf8"
      );
      await client.query(sql);
      applied = true;
    }

    if (recorded.rows.length === 0) {
      await client.query(
        `INSERT INTO schema_migrations (migration_name)
         VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [migrationName]
      );
    }

    await client.query("COMMIT");
    console.log(JSON.stringify({
      database: target.rows[0].db,
      migrationName,
      applied,
      recordedBefore: recorded.rows.length > 0,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
