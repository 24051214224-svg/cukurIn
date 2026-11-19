const assert = require("node:assert/strict");
const { after, afterEach, before, beforeEach, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const testJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = testJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");
const swaggerSpec = require("../src/docs/swagger");

let server;
let baseUrl;
let transactionHandler;
let transactionCalls;
let queryHandler;
let queryCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const otherCustomerId = "20fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberUserId = "77bb602e-22db-41a0-a8e3-1d105010e1d3";
const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
const bookingId = "4795c0ca-5c0e-4491-975a-b8f6cd6eb99f";
const reviewId = "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe";

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
  transactionCalls = [];
  queryCalls = [];
  queryHandler = async () => ({ rows: [] });
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

test("customer successfully creates a review for a completed owned booking", async () => {
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM bookings b") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: bookingId, customer_id: customerId,
        barber_id: barberId, status: "completed" }] };
    }
    if (sql.includes("SELECT id FROM reviews")) return { rows: [] };
    if (sql.includes("INSERT INTO reviews")) {
      return { rows: [{ id: reviewId, booking_id: bookingId,
        customer_id: customerId, barber_id: barberId,
        rating: params[3], comment: params[4],
        created_at: "2026-11-19T14:00:00.000Z" }] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ booking_id: bookingId, rating: 5, comment: "  Pelayanan bagus  " }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.rating, 5);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("rejects incomplete, other customer's, duplicate, and invalid review requests", async () => {
  let bookingStatus = "in_progress";
  let bookingCustomerId = customerId;
  let existingReview = false;

  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM bookings b") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: bookingId, customer_id: bookingCustomerId,
        barber_id: barberId, status: bookingStatus }] };
    }
    if (sql.includes("SELECT id FROM reviews")) {
      return { rows: existingReview ? [{ id: reviewId }] : [] };
    }
    if (sql.includes("INSERT INTO reviews")) {
      return { rows: [{ id: reviewId }] };
    }
    return { rows: [] };
  });

  const headers = {
    Authorization: `Bearer ${createToken("customer")}`,
    "Content-Type": "application/json",
  };
  const incomplete = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ booking_id: bookingId, rating: 5 }),
  });
  assert.equal(incomplete.status, 409);

  bookingStatus = "completed";
  bookingCustomerId = otherCustomerId;
  const otherCustomer = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ booking_id: bookingId, rating: 5 }),
  });
  assert.equal(otherCustomer.status, 404);

  bookingCustomerId = customerId;
  existingReview = true;
  const duplicate = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ booking_id: bookingId, rating: 4 }),
  });
  assert.equal(duplicate.status, 409);

  existingReview = false;
  for (const invalidRating of [0, 6, 3.5]) {
    const invalid = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ booking_id: bookingId, rating: invalidRating }),
    });
    assert.equal(invalid.status, 400);
  }
});

test("barber and customer can access their scoped reviews", async () => {
  queryHandler = async (sql, params) => {
    if (sql.includes("FROM barbers b") && sql.includes("WHERE b.id = $1")) {
      return { rows: [{ id: barberId }] };
    }
    if (sql.includes("FROM reviews r") && sql.includes("AVG(rating")) {
      return { rows: [{ average_rating: "4.50", review_count: 2 }] };
    }
    if (sql.includes("WHERE r.barber_id = $1")) {
      return { rows: [{ id: reviewId, barber_id: barberId, rating: 5 }] };
    }
    if (sql.includes("WHERE r.customer_id = $1")) {
      return { rows: [{ id: reviewId, customer_id: params[0], rating: 4 }] };
    }
    if (
      sql.includes("FROM reviews r") &&
      sql.includes("WHERE r.id = $1")
    ) {
      return {
        rows: [{
          id: reviewId,
          booking_id: bookingId,
          customer_id: customerId,
          barber_id: barberId,
          rating: 5,
          comment: "Bagus",
          customer_name: "Test Customer",
          barber_name: "Test Barber",
        }],
      };
    }
    return { rows: [] };
  };

  const barberResponse = await fetch(`${baseUrl}/api/reviews/barber/${barberId}`);
  assert.equal(barberResponse.status, 200);
  assert.equal(queryCalls[1][1][0], barberId);

  const myResponse = await fetch(`${baseUrl}/api/reviews/my`, {
    headers: { Authorization: `Bearer ${createToken("customer")}` },
  });
  assert.equal(myResponse.status, 200);
  assert.equal(queryCalls.at(-1)[1][0], customerId);

  const barberScoped = await fetch(`${baseUrl}/api/reviews/${reviewId}`, {
    headers: { Authorization: `Bearer ${createToken("barber", barberUserId)}` },
  });
  assert.equal(barberScoped.status, 200);
  assert.match(queryCalls.at(-1)[0], /SELECT id FROM barbers WHERE user_id = \$2/);
});

test("review endpoints require authentication and Swagger documents review routes", async () => {
  const unauthenticatedCreate = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ booking_id: bookingId, rating: 5 }),
  });
  assert.equal(unauthenticatedCreate.status, 401);

  const unauthenticatedMy = await fetch(`${baseUrl}/api/reviews/my`);
  assert.equal(unauthenticatedMy.status, 401);

  assert.equal(Boolean(swaggerSpec.paths["/api/reviews"]), true);
  assert.equal(Boolean(swaggerSpec.paths["/api/reviews/my"]), true);
  assert.equal(Boolean(swaggerSpec.paths["/api/reviews/barber/{barberId}"]), true);
  assert.equal(Boolean(swaggerSpec.paths["/api/reviews/{id}"]), true);
  assert.equal(
    swaggerSpec.paths["/api/reviews"].post.requestBody.content["application/json"].schema
      .$ref,
    "#/components/schemas/CreateReviewRequest"
  );
});

test("unique constraint is returned as conflict", async () => {
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("FROM bookings b") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: bookingId, customer_id: customerId,
        barber_id: barberId, status: "completed" }] };
    }
    if (sql.includes("SELECT id FROM reviews")) return { rows: [] };
    if (sql.includes("INSERT INTO reviews")) {
      const error = new Error("duplicate");
      error.code = "23505";
      throw error;
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/reviews`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ booking_id: bookingId, rating: 5 }),
  });
  assert.equal(response.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});
