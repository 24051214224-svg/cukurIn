require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const pool = require("../src/config/database");

(async () => {
  try {
    const migrationColumns = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
       ORDER BY ordinal_position`
    );
    console.log("migration_columns=" + JSON.stringify(migrationColumns.rows));

    const queueColumns = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'queues'
       ORDER BY ordinal_position`
    );
    console.log("queue_columns=" + JSON.stringify(queueColumns.rows));

    const constraints = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'public.queues'::regclass
       ORDER BY conname`
    );
    console.log("queue_constraints=" + JSON.stringify(constraints.rows));

    const indexes = await pool.query(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'queues'
       ORDER BY indexname`
    );
    console.log("queue_indexes=" + JSON.stringify(indexes.rows));

    const migrationContent = fs.readFileSync(
      path.join(__dirname, "..", "database", "migrations", "015_add_queue_lifecycle.sql"),
      "utf8"
    );
    console.log("migration_015_bytes=" + Buffer.byteLength(migrationContent));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
