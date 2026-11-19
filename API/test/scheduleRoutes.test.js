const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const testJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = testJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");

let server;
let baseUrl;
let queryHandler;
let queryCalls;
let transactionHandler;
let transactionCalls;
let connectCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
const scheduleId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
const userId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";

const createToken = (role) =>
  jwt.sign({ id: userId, role }, testJwtSecret);

const useMockTransaction = (handler) => {
  transactionHandler = handler;
  transactionCalls = [];
  pool.connect = async () => {
    connectCalls += 1;
    return {
      query: async (sql, params = []) => {
        transactionCalls.push({ sql, params });
        return transactionHandler(sql, params);
      },
      release: () => {},
    };
  };
};

const adminHeaders = () => ({
  Authorization: `Bearer ${createToken("admin")}`,
  "Content-Type": "application/json",
});

const scheduleBody = {
  day_of_week: 1,
  start_time: "09:00",
  end_time: "12:00",
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
  connectCalls = 0;
  pool.query = (...args) => {
    queryCalls.push(args);
    return queryHandler(...args);
  };
  pool.connect = originalConnect;
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

test("gets a barber schedule and reports barber availability", async () => {
  const rows = [
    {
      barber_id: barberId,
      barber_is_available: true,
      schedule_id: scheduleId,
      day_of_week: 1,
      start_time: "09:00:00",
      end_time: "12:00:00",
      is_available: true,
      created_at: "2026-11-18T00:00:00.000Z",
      updated_at: "2026-11-18T00:00:00.000Z",
    },
  ];
  queryHandler = async () => ({ rows });

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    barber_id: barberId,
    barber_is_available: true,
    schedules: [
      {
        id: scheduleId,
        day_of_week: 1,
        start_time: "09:00:00",
        end_time: "12:00:00",
        is_available: true,
        created_at: "2026-11-18T00:00:00.000Z",
        updated_at: "2026-11-18T00:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(queryCalls[0][1], [barberId]);
});

test("returns 404 when the requested barber does not exist", async () => {
  queryHandler = async () => ({ rows: [] });

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.success, false);
});

test("creates a schedule transactionally with normalized time values", async () => {
  const createdSchedule = {
    id: scheduleId,
    barber_id: barberId,
    day_of_week: 1,
    start_time: "09:00:00",
    end_time: "12:00:00",
    is_available: true,
  };
  useMockTransaction(async (sql) => {
    if (sql.includes("FOR UPDATE OF b, u")) {
      return {
        rows: [
          { id: barberId, barber_is_available: true, user_is_active: true },
        ],
      };
    }
    if (sql.includes("end_time > $3::time")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO schedules")) {
      return { rows: [createdSchedule] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(scheduleBody),
  });
  const body = await response.json();
  const insertCall = transactionCalls.find((call) =>
    call.sql.includes("INSERT INTO schedules")
  );

  assert.equal(response.status, 201);
  assert.deepEqual(body.data, createdSchedule);
  assert.deepEqual(insertCall.params, [barberId, 1, "09:00:00", "12:00:00", true]);
  assert.equal(transactionCalls[0].sql, "BEGIN");
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("rejects invalid day and time ranges before opening a transaction", async () => {
  const invalidDay = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ ...scheduleBody, day_of_week: 7 }),
  });
  assert.equal(invalidDay.status, 400);

  const invalidRange = await fetch(
    `${baseUrl}/api/barbers/${barberId}/schedules`,
    {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        ...scheduleBody,
        start_time: "12:00",
        end_time: "12:00",
      }),
    }
  );
  assert.equal(invalidRange.status, 400);
  assert.equal(connectCalls, 0);
});

test("requires an admin token for schedule changes", async () => {
  const path = `${baseUrl}/api/barbers/${barberId}/schedules`;
  const unauthenticated = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scheduleBody),
  });
  assert.equal(unauthenticated.status, 401);

  const customer = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${createToken("customer")}`,
    },
    body: JSON.stringify(scheduleBody),
  });
  assert.equal(customer.status, 403);
  assert.equal(connectCalls, 0);
});

test("rejects duplicate or overlapping schedules and rolls back", async () => {
  useMockTransaction(async (sql) => {
    if (sql.includes("FOR UPDATE OF b, u")) {
      return {
        rows: [
          { id: barberId, barber_is_available: true, user_is_active: true },
        ],
      };
    }
    if (sql.includes("end_time > $3::time")) {
      return { rows: [{ id: "existing-schedule" }] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(scheduleBody),
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.match(body.message, /bertabrakan/);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("rejects creation when the barber is unavailable", async () => {
  useMockTransaction(async (sql) => {
    if (sql.includes("FOR UPDATE OF b, u")) {
      return {
        rows: [
          { id: barberId, barber_is_available: false, user_is_active: true },
        ],
      };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(scheduleBody),
  });

  assert.equal(response.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("returns 404 and rolls back when scheduling a missing barber", async () => {
  useMockTransaction(async () => ({ rows: [] }));

  const response = await fetch(`${baseUrl}/api/barbers/${barberId}/schedules`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(scheduleBody),
  });

  assert.equal(response.status, 404);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("updates and deletes a schedule transactionally", async () => {
  const updatedSchedule = {
    id: scheduleId,
    barber_id: barberId,
    day_of_week: 1,
    start_time: "10:00:00",
    end_time: "13:00:00",
    is_available: true,
  };
  useMockTransaction(async (sql) => {
    if (sql.includes("FOR UPDATE OF b, u")) {
      return {
        rows: [
          { id: barberId, barber_is_available: true, user_is_active: true },
        ],
      };
    }
    if (sql.includes("WHERE id = $1 AND barber_id = $2") && sql.includes("FOR UPDATE")) {
      return {
        rows: [
          {
            id: scheduleId,
            day_of_week: 1,
            start_time: "09:00:00",
            end_time: "12:00:00",
            is_available: true,
          },
        ],
      };
    }
    if (sql.includes("end_time > $3::time")) {
      return { rows: [] };
    }
    if (sql.includes("UPDATE schedules")) {
      return { rows: [updatedSchedule] };
    }
    if (sql.includes("DELETE FROM schedules")) {
      return { rows: [{ id: scheduleId }] };
    }
    return { rows: [] };
  });

  const updateResponse = await fetch(
    `${baseUrl}/api/barbers/${barberId}/schedules/${scheduleId}`,
    {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ start_time: "10:00", end_time: "13:00" }),
    }
  );
  const updateBody = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updateBody.data, updatedSchedule);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");

  transactionCalls = [];
  const deleteResponse = await fetch(
    `${baseUrl}/api/barbers/${barberId}/schedules/${scheduleId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${createToken("admin")}` },
    }
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("Swagger documents schedule read and admin operations", () => {
  const swaggerSpec = require("../src/docs/swagger");

  assert.ok(swaggerSpec.paths["/api/barbers/{barberId}/schedules"].get);
  assert.ok(swaggerSpec.paths["/api/barbers/{barberId}/schedules"].post);
  assert.ok(
    swaggerSpec.paths[
      "/api/barbers/{barberId}/schedules/{scheduleId}"
    ].patch
  );
  assert.ok(
    swaggerSpec.paths[
      "/api/barbers/{barberId}/schedules/{scheduleId}"
    ].delete
  );
});
