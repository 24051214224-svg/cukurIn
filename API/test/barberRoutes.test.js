const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const testJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = testJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");
const swaggerSpec = require("../src/docs/swagger");
const {
  readSeedData,
  seedBarber,
} = require("../database/seeds/003_seed_barber");

let server;
let baseUrl;
let queryHandler;
let queryCalls;
let transactionHandler;
let transactionCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const createToken = (role) =>
  jwt.sign(
    { id: "9271c3fb-e0f3-4f82-b830-488594b4eaf3", role },
    testJwtSecret
  );

const useMockTransaction = (handler) => {
  transactionHandler = handler;
  transactionCalls = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      transactionCalls.push({ sql, params });
      return transactionHandler(sql, params);
    },
    release: () => {},
  });
};

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  queryCalls = [];
  queryHandler = async () => ({ rows: [] });
  transactionCalls = [];
  pool.connect = originalConnect;
  pool.query = (...args) => {
    queryCalls.push(args);
    return queryHandler(...args);
  };
});

afterEach(() => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("lists active barbers and filters availability", async () => {
  const barber = {
    id: "9271c3fb-e0f3-4f82-b830-488594b4eaf3",
    full_name: "Rafi Barber",
    is_available: false,
    average_rating: "4.50",
    review_count: 2,
    portfolio_count: 3,
  };
  queryHandler = async () => ({ rows: [barber] });

  const response = await fetch(`${baseUrl}/api/barbers?is_available=false`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [barber]);
  assert.equal(body.success, true);
  assert.deepEqual(queryCalls[0][1], [false]);
  assert.match(queryCalls[0][0], /u\.role = 'barber'/);
});

test("rejects invalid availability filters without querying the database", async () => {
  const response = await fetch(`${baseUrl}/api/barbers?is_available=maybe`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(queryCalls.length, 0);
});

test("admin barber list includes inactive accounts and is role-protected", async () => {
  queryHandler = async () => ({ rows: [{ id: "inactive-barber", is_active: false }] });

  const unauthorized = await fetch(`${baseUrl}/api/barbers/admin`);
  assert.equal(unauthorized.status, 401);
  assert.equal(queryCalls.length, 0);

  const response = await fetch(`${baseUrl}/api/barbers/admin`, {
    headers: { Authorization: `Bearer ${createToken("admin")}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].is_active, false);
  assert.equal(queryCalls.length, 1);
});

test("returns barber details with portfolio items", async () => {
  const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
  const barber = { id: barberId, full_name: "Rafi Barber" };
  const portfolio = { id: "portfolio-1", title: "Fade" };
  queryHandler = async (sql) => {
    if (sql.includes("FROM portfolios")) {
      return { rows: [portfolio] };
    }
    return { rows: [barber] };
  };

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { ...barber, portfolios: [portfolio] });
  assert.deepEqual(queryCalls.map((call) => call[1]), [[barberId], [barberId]]);
});

test("returns 404 for an unknown barber", async () => {
  queryHandler = async () => ({ rows: [] });

  const missingResponse = await fetch(
    `${baseUrl}/api/barbers/9271c3fb-e0f3-4f82-b830-488594b4eaf3`
  );
  assert.equal(missingResponse.status, 404);
  assert.equal(queryCalls.length, 1);
});

test("rejects invalid barber IDs without querying the database", async () => {
  const response = await fetch(`${baseUrl}/api/barbers/not-a-uuid`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(queryCalls.length, 0);
});

test("creates barber and hashes the password within one transaction", async () => {
  const userId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
  const barberId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
  const profile = {
    id: barberId,
    full_name: "Test Barber",
    email: "barber@example.invalid",
    is_active: true,
  };
  useMockTransaction(async (sql) => {
    if (sql.includes("INSERT INTO users")) {
      return { rows: [{ id: userId }] };
    }
    if (sql.includes("INSERT INTO barbers")) {
      return { rows: [{ id: barberId }] };
    }
    if (sql.includes("SELECT b.id")) {
      return { rows: [profile] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/barbers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("admin")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      full_name: "Test Barber",
      email: "BARBER@example.invalid",
      phone_number: "081234567890",
      password: "temporary-test-password",
    }),
  });
  const body = await response.json();
  const userInsert = transactionCalls.find((call) =>
    call.sql.includes("INSERT INTO users")
  );

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.id, barberId);
  assert.equal(JSON.stringify(body).includes("password_hash"), false);
  assert.equal(await bcrypt.compare("temporary-test-password", userInsert.params[3]), true);
  assert.equal(transactionCalls[0].sql, "BEGIN");
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("maps duplicate barber identities to conflict and rolls back", async () => {
  useMockTransaction(async (sql) => {
    if (sql.includes("INSERT INTO users")) {
      const error = new Error("unique violation");
      error.code = "23505";
      throw error;
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/barbers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("admin")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      full_name: "Test Barber",
      email: "barber@example.invalid",
      phone_number: "081234567890",
      password: "temporary-test-password",
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.success, false);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("barber management rejects customer and unauthenticated writes", async () => {
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Test Barber",
      email: "barber@example.invalid",
      phone_number: "081234567890",
      password: "temporary-test-password",
    }),
  };

  const unauthenticated = await fetch(`${baseUrl}/api/barbers`, request);
  assert.equal(unauthenticated.status, 401);

  const customerResponse = await fetch(`${baseUrl}/api/barbers`, {
    ...request,
    headers: {
      ...request.headers,
      Authorization: `Bearer ${createToken("customer")}`,
    },
  });
  assert.equal(customerResponse.status, 403);
  assert.equal(transactionCalls.length, 0);
});

test("validates create and update payloads before database access", async () => {
  const adminHeader = { Authorization: `Bearer ${createToken("admin")}` };
  const invalidCreate = await fetch(`${baseUrl}/api/barbers`, {
    method: "POST",
    headers: { ...adminHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "AB",
      email: "not-an-email",
      phone_number: "123",
      password: "short",
    }),
  });
  assert.equal(invalidCreate.status, 400);

  const emptyUpdate = await fetch(
    `${baseUrl}/api/barbers/69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8`,
    {
      method: "PUT",
      headers: { ...adminHeader, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );
  assert.equal(emptyUpdate.status, 400);
  assert.equal(transactionCalls.length, 0);
});

test("updates and deactivates barber profiles transactionally", async () => {
  const barberId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
  const userId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
  let updatedProfile = {
    id: barberId,
    full_name: "Updated Barber",
    is_active: false,
    is_available: false,
  };
  useMockTransaction(async (sql) => {
    if (sql.includes("SELECT b.id, b.user_id")) {
      return { rows: [{ id: barberId, user_id: userId }] };
    }
    if (sql.includes("SELECT b.id,") && sql.includes("u.email")) {
      return { rows: [updatedProfile] };
    }
    return { rows: [] };
  });

  const updateResponse = await fetch(`${baseUrl}/api/barbers/${barberId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${createToken("admin")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ is_active: false }),
  });
  assert.equal(updateResponse.status, 200);
  assert.match(
    transactionCalls.find((call) => call.sql.includes("UPDATE barbers")).sql,
    /WHEN \$6 IS FALSE THEN FALSE/
  );
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");

  transactionCalls = [];
  const deleteResponse = await fetch(`${baseUrl}/api/barbers/${barberId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${createToken("admin")}` },
  });
  const deleteBody = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteBody.data, {
    id: barberId,
    is_active: false,
    is_available: false,
  });
  assert.equal(
    transactionCalls.some((call) => call.sql.includes("DELETE FROM")),
    false
  );
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("barber seed input requires credentials without embedding them in errors", () => {
  const envKeys = [
    "SEED_BARBER_NAME",
    "SEED_BARBER_EMAIL",
    "SEED_BARBER_PHONE",
    "SEED_BARBER_PASSWORD",
  ];
  const previousValues = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]])
  );

  try {
    process.env.SEED_BARBER_NAME = "Seed Test Barber";
    process.env.SEED_BARBER_EMAIL = "seed@example.invalid";
    process.env.SEED_BARBER_PHONE = "081234567890";
    process.env.SEED_BARBER_PASSWORD = "temporary-seed-password";

    assert.equal(readSeedData().full_name, "Seed Test Barber");

    process.env.SEED_BARBER_PASSWORD = "short";
    assert.throws(readSeedData, /SEED_BARBER_PASSWORD|password/);
  } finally {
    for (const key of envKeys) {
      if (previousValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValues[key];
      }
    }
  }
});

test("barber seed links user and profile with a bcrypt hash transactionally", async () => {
  const userId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
  const barberId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
  const insertCalls = [];
  useMockTransaction(async (sql, params) => {
    if (sql.includes("SELECT id, role")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO users")) {
      insertCalls.push({ sql, params });
      return { rows: [{ id: userId }] };
    }
    if (sql.includes("INSERT INTO barbers")) {
      insertCalls.push({ sql, params });
      return { rows: [{ id: barberId }] };
    }
    return { rows: [] };
  });

  const seededId = await seedBarber({
    full_name: "Seed Test Barber",
    email: "seed@example.invalid",
    phone_number: "081234567890",
    password: "temporary-seed-password",
    bio: null,
    experience_years: 2,
    is_available: true,
  });
  const userInsert = insertCalls.find((call) =>
    call.sql.includes("INSERT INTO users")
  );
  const barberInsert = insertCalls.find((call) =>
    call.sql.includes("INSERT INTO barbers")
  );

  assert.equal(seededId, barberId);
  assert.equal(await bcrypt.compare("temporary-seed-password", userInsert.params[3]), true);
  assert.equal(barberInsert.params[0], userId);
  assert.equal(transactionCalls[0].sql, "BEGIN");
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("barber seed refuses to promote an existing non-barber account", async () => {
  useMockTransaction(async (sql) => {
    if (sql.includes("SELECT id, role")) {
      return { rows: [{ id: "customer-id", role: "customer" }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    seedBarber({
      full_name: "Seed Test Barber",
      email: "seed@example.invalid",
      phone_number: "081234567890",
      password: "temporary-seed-password",
      bio: null,
      experience_years: 0,
      is_available: true,
    }),
    /non-barber account/
  );
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
  assert.equal(
    transactionCalls.some((call) => call.sql.includes("INSERT INTO")),
    false
  );
});

test("Swagger includes all existing and barber-management API routes", () => {
  assert.ok(swaggerSpec.paths["/api/auth/me"]);
  assert.ok(swaggerSpec.paths["/api/services/{id}"]);
  assert.ok(swaggerSpec.paths["/api/barbers/admin"]);
  assert.ok(swaggerSpec.paths["/api/barbers/{id}"].delete);
});
