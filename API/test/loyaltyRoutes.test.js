const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const testJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
const previousRupiahPerPoint = process.env.LOYALTY_RUPIAH_PER_POINT;
process.env.JWT_SECRET = testJwtSecret;
process.env.LOYALTY_RUPIAH_PER_POINT = "10000";

const app = require("../src/app");
const pool = require("../src/config/database");
const swaggerSpec = require("../src/docs/swagger");
const {
  awardCompletedBookingPoints,
  calculateEarnedPoints,
} = require("../src/services/loyaltyService");

let server;
let baseUrl;
let queryHandler;
let queryCalls;
let transactionHandler;
let transactionCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const otherCustomerId = "20fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberId = "77bb602e-22db-41a0-a8e3-1d105010e1d3";
const bookingId = "4795c0ca-5c0e-4491-975a-b8f6cd6eb99f";

const createToken = (role, id = customerId) =>
  jwt.sign({ id, role }, testJwtSecret);

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
  if (previousRupiahPerPoint === undefined) {
    delete process.env.LOYALTY_RUPIAH_PER_POINT;
  } else {
    process.env.LOYALTY_RUPIAH_PER_POINT = previousRupiahPerPoint;
  }
});

test("loyalty endpoints require a customer JWT", async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/loyalty/balance`);
  assert.equal(unauthenticated.status, 401);

  const barber = await fetch(`${baseUrl}/api/loyalty/balance`, {
    headers: { Authorization: `Bearer ${createToken("barber", barberId)}` },
  });
  assert.equal(barber.status, 403);
});

test("balance and history are scoped to the authenticated customer", async () => {
  queryHandler = async (sql, params) => {
    if (sql.includes("SUM(points)")) {
      return { rows: [{ balance: params[0] === customerId ? "12" : "0" }] };
    }
    return {
      rows: [{
        id: "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe",
        transaction_type: "earn",
        points: 12,
      }],
    };
  };

  const headers = { Authorization: `Bearer ${createToken("customer")}` };
  const balanceResponse = await fetch(`${baseUrl}/api/loyalty/balance`, { headers });
  const balanceBody = await balanceResponse.json();
  assert.equal(balanceResponse.status, 200);
  assert.equal(balanceBody.data.balance, 12);
  assert.deepEqual(queryCalls[0][1], [customerId]);

  const historyResponse = await fetch(
    `${baseUrl}/api/loyalty/history?limit=10&offset=0`,
    { headers }
  );
  const historyBody = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.equal(historyBody.data.transactions.length, 1);
  assert.deepEqual(queryCalls[1][1], [customerId, 10, 0]);
  assert.match(queryCalls[1][0], /WHERE user_id = \$1/);

  const crossCustomerResponse = await fetch(
    `${baseUrl}/api/loyalty/balance?user_id=${customerId}`,
    { headers: { Authorization: `Bearer ${createToken("customer", otherCustomerId)}` } }
  );
  const crossCustomerBody = await crossCustomerResponse.json();
  assert.equal(crossCustomerResponse.status, 200);
  assert.equal(crossCustomerBody.data.balance, 0);
  assert.deepEqual(queryCalls[2][1], [otherCustomerId]);
});

test("redeem requires positive integer points and rejects user_id", async () => {
  let connectCalls = 0;
  pool.connect = async () => {
    connectCalls += 1;
    throw new Error("Unexpected database access");
  };

  for (const body of [
    { points: 0 },
    { points: -1 },
    { points: 1.5 },
    { points: "1" },
    { points: 1, user_id: otherCustomerId },
  ]) {
    const response = await fetch(`${baseUrl}/api/loyalty/redeem`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createToken("customer")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(connectCalls, 0);
});

test("redeem records a negative ledger entry and returns the new balance", async () => {
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: customerId }] };
    }
    if (sql.includes("SUM(points)")) {
      return { rows: [{ balance: "8" }] };
    }
    if (sql.includes("INSERT INTO loyalty_points")) {
      return {
        rows: [{
          id: "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe",
          transaction_type: "redeem",
          points: params[1],
        }],
      };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/loyalty/redeem`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ points: 3 }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.transaction.points, -3);
  assert.equal(body.data.balance, 5);
  assert.deepEqual(transactionCalls[1].params, [customerId]);
  assert.deepEqual(transactionCalls.at(-1), { sql: "COMMIT", params: [] });
});

test("insufficient balance and transaction failure roll back redemption", async () => {
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("FROM users")) return { rows: [{ id: customerId }] };
    if (sql.includes("SUM(points)")) return { rows: [{ balance: "2" }] };
    return { rows: [] };
  });

  const insufficient = await fetch(`${baseUrl}/api/loyalty/redeem`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ points: 3 }),
  });
  assert.equal(insufficient.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
  assert.equal(transactionCalls.some((call) => call.sql.includes("INSERT INTO loyalty_points")), false);

  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("FROM users")) return { rows: [{ id: customerId }] };
    if (sql.includes("SUM(points)")) return { rows: [{ balance: "2" }] };
    if (sql.includes("INSERT INTO loyalty_points")) {
      throw new Error("simulated insert failure");
    }
    return { rows: [] };
  });

  const failed = await fetch(`${baseUrl}/api/loyalty/redeem`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ points: 1 }),
  });
  assert.equal(failed.status, 500);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("completion awards floored points once and ignores incomplete bookings", async () => {
  assert.equal(calculateEarnedPoints("25999.99", 10_000), 2);
  assert.equal(calculateEarnedPoints("9999.99", 10_000), 0);

  let inserted = false;
  const clientCalls = [];
  const client = {
    query: async (sql, params) => {
      clientCalls.push({ sql, params });
      if (sql.includes("FROM bookings b")) {
        return {
          rows: [{
            customer_id: customerId,
            total_price: "25999.99",
          }],
        };
      }
      if (sql.includes("INSERT INTO loyalty_points")) {
        if (inserted) return { rows: [] };
        inserted = true;
        return { rows: [{ booking_id: bookingId, points: params[2] }] };
      }
      return { rows: [] };
    },
  };

  const first = await awardCompletedBookingPoints(client, bookingId);
  const duplicate = await awardCompletedBookingPoints(client, bookingId);
  assert.equal(first.points, 2);
  assert.equal(duplicate, null);
  assert.equal(clientCalls.filter((call) => call.sql.includes("INSERT INTO loyalty_points")).length, 2);

  const incompleteClient = {
    query: async (sql) => {
      assert.match(sql, /status = 'completed'/);
      return { rows: [] };
    },
  };
  assert.equal(await awardCompletedBookingPoints(incompleteClient, bookingId), null);
});

test("Swagger declares the loyalty endpoints", () => {
  assert.ok(swaggerSpec.paths["/api/loyalty/balance"].get);
  assert.ok(swaggerSpec.paths["/api/loyalty/history"].get);
  assert.ok(swaggerSpec.paths["/api/loyalty/redeem"].post);
});
