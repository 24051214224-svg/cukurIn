const TEST_DATABASE_MARKER = "cukurin-p0-postgres-integration-test";

const verifyPostgresTestDatabase = async (pool) => {
  const expectedDatabaseName = process.env.POSTGRES_TEST_DB_NAME?.trim();
  const configuredDatabaseName = process.env.DB_NAME?.trim();

  if (!expectedDatabaseName) {
    throw new Error(
      "POSTGRES_TEST_DB_NAME must identify an explicitly provisioned test database"
    );
  }
  if (expectedDatabaseName.toLowerCase() === "cukurin_db") {
    throw new Error("PostgreSQL integration tests cannot use cukurin_db");
  }
  if (!configuredDatabaseName || configuredDatabaseName !== expectedDatabaseName) {
    throw new Error(
      "DB_NAME must exactly match POSTGRES_TEST_DB_NAME; refusing an unverified target"
    );
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT current_database() AS database_name,
              shobj_description(oid, 'pg_database') AS database_comment
       FROM pg_database
       WHERE datname = current_database()`
    );
    const database = result.rows[0];
    if (
      database?.database_name !== expectedDatabaseName ||
      database.database_comment !== TEST_DATABASE_MARKER
    ) {
      throw new Error(
        "Connected PostgreSQL database does not have the required test-only marker"
      );
    }
  } finally {
    client.release();
  }
};

module.exports = verifyPostgresTestDatabase;
