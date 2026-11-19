require("dotenv").config();
const pool = require("../src/config/database");

(async () => {
  try {
    const target = await pool.query(
      `SELECT current_database() AS db,
              current_user AS usr,
              inet_server_addr() AS host,
              inet_server_port() AS port,
              current_setting('TimeZone') AS tz`
    );
    console.log(JSON.stringify(target.rows[0]));

    const migrationTable = await pool.query(
      "SELECT to_regclass('public.schema_migrations') AS name"
    );
    console.log(JSON.stringify(migrationTable.rows[0]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
