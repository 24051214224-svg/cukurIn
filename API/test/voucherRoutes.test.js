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
const { calculateVoucherPrice } = require("../src/services/voucherService");

let server;
let baseUrl;
let queryHandler;
let queryCalls;
let transactionHandler;
let transactionCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const serviceId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
const voucherId = "936fd05a-c130-40e7-9e0a-71d8084c77c4";
const createToken = (role, id = customerId) =>
  jwt.sign({ id, role }, testJwtSecret);

const futureRange = () => ({
  start_at: new Date(Date.now() - 60_000).toISOString(),
  end_at: new Date(Date.now() + 60 * 60_000).toISOString(),
});

const createVoucherBody = (overrides = {}) => ({
  code: "  save10 ",
  discount_type: "percentage",
  discount_value: 10,
  usage_limit: 10,
  ...futureRange(),
  ...overrides,
});

const request = (path, role, method = "GET", body) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(role ? { Authorization: `Bearer ${createToken(role)}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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
});

test("voucher validation is customer-only and prices services from the database", async () => {
  const noToken = await request(
    "/api/vouchers/validate",
    null,
    "POST",
    { code: "save10", items: [{ service_id: serviceId }] }
  );
  assert.equal(noToken.status, 401);

  const barber = await request(
    "/api/vouchers/validate",
    "barber",
    "POST",
    { code: "save10", items: [{ service_id: serviceId }] }
  );
  assert.equal(barber.status, 403);

  queryHandler = async (sql) => {
    if (sql.includes("FROM services")) {
      return {
        rows: [{
          id: serviceId,
          service_name: "Haircut",
          price: "25000.00",
          duration_minutes: 30,
        }],
      };
    }
    if (sql.includes("FROM vouchers")) {
      return {
        rows: [{
          id: voucherId,
          code: "SAVE10",
          discount_type: "percentage",
          discount_value: "10.00",
          minimum_transaction: "0.00",
          max_discount: null,
          usage_limit: 10,
          used_count: 2,
          start_at: new Date(Date.now() - 60_000),
          end_at: new Date(Date.now() + 60 * 60_000),
          is_active: true,
          evaluated_at: new Date(),
        }],
      };
    }
    return { rows: [] };
  };

  const response = await request(
    "/api/vouchers/validate",
    "customer",
    "POST",
    { code: " save10 ", items: [{ service_id: serviceId, quantity: 1 }] }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.subtotal, "25000.00");
  assert.equal(body.data.discount_amount, "2500.00");
  assert.equal(body.data.total_price, "22500.00");
  assert.equal(queryCalls[1][1][0], "SAVE10");
  assert.match(queryCalls[0][0], /FROM services/);
});

test("voucher validation ignores client totals and checks minimum transaction", async () => {
  const extraInput = await request(
    "/api/vouchers/validate",
    "customer",
    "POST",
    {
      code: "SAVE10",
      total_price: 1,
      items: [{ service_id: serviceId }],
    }
  );
  assert.equal(extraInput.status, 400);
  assert.equal(queryCalls.length, 0);

  queryHandler = async (sql) => {
    if (sql.includes("FROM services")) {
      return {
        rows: [{
          id: serviceId,
          service_name: "Haircut",
          price: "25000.00",
          duration_minutes: 30,
        }],
      };
    }
    return {
      rows: [{
        id: voucherId,
        code: "SAVE10",
        discount_type: "fixed",
        discount_value: "1000.00",
        minimum_transaction: "30000.00",
        max_discount: null,
        usage_limit: 10,
        used_count: 0,
        start_at: new Date(Date.now() - 60_000),
        end_at: new Date(Date.now() + 60 * 60_000),
        is_active: true,
        evaluated_at: new Date(),
      }],
    };
  };
  const belowMinimum = await request(
    "/api/vouchers/validate",
    "customer",
    "POST",
    { code: "SAVE10", items: [{ service_id: serviceId }] }
  );
  assert.equal(belowMinimum.status, 409);
});

test("admin creates vouchers with normalized codes and required global quota", async () => {
  const forbidden = await request(
    "/api/vouchers",
    "customer",
    "POST",
    createVoucherBody()
  );
  assert.equal(forbidden.status, 403);

  queryHandler = async (_sql, params) => ({
    rows: [{ id: voucherId, code: params[0] }],
  });
  const response = await request(
    "/api/vouchers",
    "admin",
    "POST",
    createVoucherBody({ max_discount: 5000 })
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.code, "SAVE10");
  assert.equal(queryCalls[0][1][0], "SAVE10");

  const missingQuota = await request(
    "/api/vouchers",
    "admin",
    "POST",
    createVoucherBody({ usage_limit: undefined })
  );
  assert.equal(missingQuota.status, 400);
});

test("admin can deactivate vouchers and cannot reduce quota below usage", async () => {
  const currentVoucher = {
    id: voucherId,
    code: "SAVE10",
    description: null,
    discount_type: "percentage",
    discount_value: "10.00",
    minimum_transaction: "0.00",
    max_discount: null,
    usage_limit: 10,
    used_count: 4,
    start_at: new Date(Date.now() - 60_000),
    end_at: new Date(Date.now() + 60 * 60_000),
    is_active: true,
  };
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("SELECT id, code") && sql.includes("FOR UPDATE")) {
      return { rows: [currentVoucher] };
    }
    if (sql.includes("UPDATE vouchers")) {
      return { rows: [{ ...currentVoucher, is_active: params[9] }] };
    }
    return { rows: [] };
  });

  const deactivated = await request(
    `/api/vouchers/${voucherId}`,
    "admin",
    "PATCH",
    { is_active: false }
  );
  assert.equal(deactivated.status, 200);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
  assert.equal(
    transactionCalls.find((call) => call.sql.includes("UPDATE vouchers")).params[9],
    false
  );

  transactionCalls = [];
  const reducedQuota = await request(
    `/api/vouchers/${voucherId}`,
    "admin",
    "PATCH",
    { usage_limit: 3 }
  );
  assert.equal(reducedQuota.status, 409);
  assert.equal(transactionCalls.some((call) => call.sql.includes("UPDATE vouchers")), false);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("fixed discounts cannot exceed the service subtotal", () => {
  const price = calculateVoucherPrice(
    {
      is_active: true,
      evaluated_at: new Date(),
      start_at: new Date(Date.now() - 60_000),
      end_at: new Date(Date.now() + 60_000),
      used_count: 0,
      usage_limit: 1,
      minimum_transaction: "0.00",
      discount_type: "fixed",
      discount_value: "50000.00",
      max_discount: null,
    },
    2500000
  );

  assert.equal(price.discountAmount, "25000.00");
  assert.equal(price.totalPrice, "0.00");
});

test("Swagger documents voucher management, validation, and booking integration", () => {
  assert.ok(swaggerSpec.paths["/api/vouchers"].get);
  assert.ok(swaggerSpec.paths["/api/vouchers"].post);
  assert.ok(swaggerSpec.paths["/api/vouchers/validate"].post);
  assert.ok(swaggerSpec.paths["/api/vouchers/{id}"].patch);
  assert.equal(
    swaggerSpec.components.schemas.CreateBookingRequest.properties.voucher_code
      .maxLength,
    30
  );
});
