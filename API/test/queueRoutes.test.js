const assert = require("node:assert/strict");
const { after, before, beforeEach, afterEach, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const testJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = testJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");

let server;
let baseUrl;
let transactionHandler;
let transactionCalls;
let connectCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const otherCustomerId = "20fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
const barberUserId = "77bb602e-22db-41a0-a8e3-1d105010e1d3";
const bookingId = "4795c0ca-5c0e-4491-975a-b8f6cd6eb99f";
const queueId = "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe";
const qrToken = "e3b7e55d-f0df-4c83-a5d9-94204ab70d2f";

const createToken = (role, id = customerId) =>
  jwt.sign({ id, role }, testJwtSecret);

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

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  transactionCalls = [];
  connectCalls = 0;
  pool.query = async () => ({ rows: [] });
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

test("queue creation is unique by barber/date and is only created once", async () => {
  const seenBookings = new Set();
  let nextNumber = 1;
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("SELECT id FROM queues WHERE booking_id = $1")) {
      return seenBookings.has(params[0]) ? { rows: [{ id: queueId }] } : { rows: [] };
    }
    if (sql.includes("FROM bookings b") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: bookingId, barber_id: barberId, customer_id: customerId,
        start_at: "2026-11-20T03:00:00.000Z", status: "confirmed" }] };
    }
    if (sql.includes("SELECT id FROM barbers")) return { rows: [{ id: barberId }] };
    if (sql.includes("COALESCE(MAX(queue_number)")) {
      return { rows: [{ next_number: nextNumber++ }] };
    }
    if (sql.includes("INSERT INTO queues")) {
      seenBookings.add(params[0]);
      return { rows: [{ id: queueId }] };
    }
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) return { rows: [] };
    return { rows: [] };
  });

  const queueModule = require("../src/controllers/queueController");
  const firstClient = await pool.connect();
  await firstClient.query("BEGIN");
  const created = await queueModule.createQueueForConfirmedBooking(
    firstClient,
    bookingId
  );
  await firstClient.query("COMMIT");
  firstClient.release();

  assert.equal(created.id, queueId);
  const insertCount = transactionCalls.filter((call) => call.sql.includes("INSERT INTO queues")).length;
  assert.equal(insertCount, 1);
  assert.equal(transactionCalls.some((call) =>
    call.sql.includes("uq_barber_queue_number") === true), false);
});

test("customer only sees its own queue and cannot see another customer's queue", async () => {
  let detailCustomer = customerId;
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FOR UPDATE OF q, b")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "waiting", customer_id: detailCustomer,
        barber_user_id: barberUserId }] };
    }
    if (sql.includes("FROM queues q") && sql.includes("WHERE q.id = $1")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", queue_number: 1, status: "waiting",
        customer_id: detailCustomer, customer_name: "Customer" }] };
    }
    if (sql.includes("FROM booking_items")) return { rows: [] };
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) return { rows: [] };
    return { rows: [] };
  });

  const visible = await fetch(`${baseUrl}/api/queues/${queueId}`, {
    headers: { Authorization: `Bearer ${createToken("customer", customerId)}` },
  });
  assert.equal(visible.status, 200);

  detailCustomer = otherCustomerId;
  const hidden = await fetch(`${baseUrl}/api/queues/${queueId}`, {
    headers: { Authorization: `Bearer ${createToken("customer", customerId)}` },
  });
  assert.equal(hidden.status, 404);
});

test("barber ownership is enforced and admin can manage all queues", async () => {
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FOR UPDATE OF q, b")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "waiting", customer_id: customerId,
        barber_user_id: barberUserId }] };
    }
    if (sql.includes("SET status = $2")) return { rows: [] };
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) return { rows: [] };
    if (sql.includes("FROM booking_items")) return { rows: [] };
    if (sql.includes("FROM queues q") && sql.includes("WHERE q.id = $1")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "called", customer_id: customerId }] };
    }
    return { rows: [] };
  });

  const wrongBarber = await fetch(`${baseUrl}/api/queues/${queueId}/call`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("barber", otherCustomerId)}` },
  });
  assert.equal(wrongBarber.status, 404);

  const admin = await fetch(`${baseUrl}/api/queues/${queueId}/call`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("admin")}` },
  });
  assert.equal(admin.status, 200);
});

test("QR check-in succeeds once and rejects a reused token", async () => {
  let checkedIn = null;
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("WHERE q.qr_token = $1")) {
      return { rows: [{ id: queueId, barber_id: barberId, queue_date: "2026-11-20",
        status: "waiting", checked_in_at: checkedIn, customer_id: customerId }] };
    }
    if (sql.includes("SET checked_in_at")) {
      checkedIn = "2026-11-20T03:05:00.000Z";
      return { rows: [] };
    }
    if (sql.includes("FROM queues q") && sql.includes("WHERE q.id = $1")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "waiting", checked_in_at: checkedIn,
        customer_id: customerId }] };
    }
    if (sql.includes("FROM booking_items")) return { rows: [] };
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) return { rows: [] };
    return { rows: [] };
  });

  const first = await fetch(`${baseUrl}/api/queues/check-in`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ qr_token: qrToken }),
  });
  assert.equal(first.status, 200);

  const reused = await fetch(`${baseUrl}/api/queues/check-in`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ qr_token: qrToken }),
  });
  assert.equal(reused.status, 409);
});

test("invalid transitions and unauthenticated requests are rejected", async () => {
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FOR UPDATE OF q, b")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "waiting", customer_id: customerId,
        barber_user_id: barberUserId, checked_in_at: null }] };
    }
    return { rows: [] };
  });

  const unauthorized = await fetch(`${baseUrl}/api/queues/${queueId}`);
  assert.equal(unauthorized.status, 401);

  const invalid = await fetch(`${baseUrl}/api/queues/${queueId}/complete`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("barber", barberUserId)}` },
  });
  assert.equal(invalid.status, 409);
});

test("queue completion synchronizes the completed booking", async () => {
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FOR UPDATE OF q, b")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "serving", customer_id: customerId,
        barber_user_id: barberUserId }] };
    }
    if (sql.includes("SET status = $2, updated_at")) {
      return { rows: [] };
    }
    if (sql.includes("UPDATE bookings") && sql.includes("'completed'")) {
      assert.equal(params[1], "completed");
      return { rows: [{ id: bookingId, status: "completed" }] };
    }
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) return { rows: [] };
    if (sql.includes("FROM booking_items")) return { rows: [] };
    if (sql.includes("FROM queues q") && sql.includes("WHERE q.id = $1")) {
      return { rows: [{ id: queueId, booking_id: bookingId, barber_id: barberId,
        queue_date: "2026-11-20", status: "completed", booking_status: "completed",
        customer_id: customerId }] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/queues/${queueId}/complete`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("barber", barberUserId)}` },
  });
  assert.equal(response.status, 200);
  assert.equal(transactionCalls.some((call) =>
    call.sql.includes("UPDATE bookings") && call.params?.[1] === "completed"), true);
});

test("Smart ETA includes serving duration and excludes completed/cancelled queues", async () => {
  const queueModule = require("../src/controllers/queueController");
  const now = Date.parse("2026-11-20T03:00:00.000Z");
  const queues = [
    {
      id: "a",
      status: "serving",
      queue_number: 1,
      started_at: "2026-11-20T02:50:00.000Z",
      updated_at: "2026-11-20T02:50:00.000Z",
      duration_minutes: 30,
      booking_start_at: "2026-11-20T02:50:00.000Z",
    },
    {
      id: "b",
      status: "waiting",
      queue_number: 2,
      duration_minutes: 20,
      booking_start_at: "2026-11-20T03:00:00.000Z",
    },
    {
      id: "c",
      status: "completed",
      queue_number: 3,
      duration_minutes: 60,
      booking_start_at: "2026-11-20T03:30:00.000Z",
    },
  ];

  const estimates = queueModule.calculateSmartEta(queues, now);
  assert.equal(estimates.has("a"), true);
  assert.equal(estimates.has("b"), true);
  assert.equal(estimates.has("c"), false);
  assert.equal(estimates.get("b").wait_minutes, 20);
  assert.equal(estimates.get("b").estimated_end_at,
    "2026-11-20T03:40:00.000Z");
});
