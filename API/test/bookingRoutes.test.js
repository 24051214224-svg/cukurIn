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
let queryHandler;
let queryCalls;
let transactionHandler;
let transactionCalls;
let connectCalls;
const originalQuery = pool.query;
const originalConnect = pool.connect;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
const barberUserId = "77bb602e-22db-41a0-a8e3-1d105010e1d3";
const serviceId = "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8";
const bookingId = "4795c0ca-5c0e-4491-975a-b8f6cd6eb99f";

const createToken = (role, id = customerId) =>
  jwt.sign({ id, role }, testJwtSecret);

const futureStartAt = () => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 2);
  const dateAtBusinessHour = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3)
  );
  dateAtBusinessHour.setUTCSeconds(0, 0);
  return dateAtBusinessHour.toISOString();
};

const createRequestBody = (overrides = {}) => ({
  barber_id: barberId,
  start_at: futureStartAt(),
  items: [{ service_id: serviceId, quantity: 1 }],
  ...overrides,
});

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

const configureCreateTransaction = ({
  customerExists = true,
  barber = {
    id: barberId,
    is_available: true,
    user_is_active: true,
  },
  services = [
    {
      id: serviceId,
      service_name: "Haircut",
      price: "25000.00",
      duration_minutes: 30,
    },
  ],
  schedules = [{ id: "available-schedule" }],
  conflicts = [],
  voucher = null,
  bookingTotalPrice = "25000.00",
} = {}) => {
  const insertedItems = [];
  let insertedBookingId;

  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("role = 'customer'")) {
      return { rows: customerExists ? [{ id: customerId }] : [] };
    }
    if (sql.includes("FOR UPDATE OF b, u")) {
      return { rows: barber ? [barber] : [] };
    }
    if (sql.includes("FROM services")) {
      return { rows: services };
    }
    if (sql.includes("FROM vouchers")) {
      return { rows: voucher ? [voucher] : [] };
    }
    if (sql.includes("SET used_count = used_count + 1")) {
      return { rows: [{ used_count: 1 }] };
    }
    if (sql.includes("FROM schedules")) {
      return { rows: schedules };
    }
    if (sql.includes("FROM bookings") && sql.includes("status IN")) {
      return { rows: conflicts };
    }
    if (sql.includes("INSERT INTO bookings")) {
      insertedBookingId = bookingId;
      return { rows: [{ id: insertedBookingId }] };
    }
    if (sql.includes("INSERT INTO booking_items")) {
      insertedItems.push(params);
      return { rows: [] };
    }
    if (sql.includes("booking_code")) {
      return {
        rows: [
          {
            id: insertedBookingId,
            booking_code: "CK-TEST",
            customer_id: customerId,
            customer_name: "Test Customer",
            barber_id: barberId,
            barber_name: "Test Barber",
            start_at: params[0],
            end_at: params[0],
            status: "pending",
            total_price: bookingTotalPrice,
            voucher_id: voucher?.id ?? null,
            voucher_code: voucher?.code ?? null,
            discount_amount: "0.00",
            notes: null,
            created_at: "2026-11-18T00:00:00.000Z",
            updated_at: "2026-11-18T00:00:00.000Z",
          },
        ],
      };
    }
    if (sql.includes("FROM booking_items")) {
      return {
        rows: insertedItems.map((item, index) => ({
          id: `item-${index + 1}`,
          service_id: item[1],
          service_name: item[2],
          quantity: item[3],
          unit_price: item[4],
          duration_minutes: item[5],
          subtotal: "25000.00",
        })),
      };
    }
    return { rows: [] };
  });
};

const adminHeaders = () => ({
  Authorization: `Bearer ${createToken("admin")}`,
  "Content-Type": "application/json",
});

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

test("customer creates a booking using database service price and duration", async () => {
  configureCreateTransaction();
  const requestBody = createRequestBody({
    items: [{ service_id: serviceId, quantity: 2 }],
    notes: "  appointment note  ",
  });

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.json();
  const insertBooking = transactionCalls.find((call) =>
    call.sql.includes("INSERT INTO bookings")
  );
  const insertItem = transactionCalls.find((call) =>
    call.sql.includes("INSERT INTO booking_items")
  );
  const serviceLookup = transactionCalls.find((call) =>
    call.sql.includes("FROM services")
  );
  const expectedEnd = new Date(
    new Date(requestBody.start_at).getTime() + 60 * 60 * 1000
  ).toISOString();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(body.data.status, "pending");
  assert.equal(body.data.booking_code.startsWith("CK-"), true);
  assert.equal(insertBooking.params[5], "50000.00");
  assert.equal(insertBooking.params[4], expectedEnd);
  assert.equal(insertBooking.params[6], "appointment note");
  assert.deepEqual(insertItem.params.slice(1), [
    serviceId,
    "Haircut",
    2,
    "25000.00",
    30,
  ]);
  assert.match(serviceLookup.sql, /is_active = TRUE/);
  assert.equal(transactionCalls[0].sql, "BEGIN");
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("booking applies a normalized voucher and reserves its quota atomically", async () => {
  const voucher = {
    id: "936fd05a-c130-40e7-9e0a-71d8084c77c4",
    code: "SAVE10",
    discount_type: "percentage",
    discount_value: "10.00",
    minimum_transaction: "0.00",
    max_discount: "1000.00",
    usage_limit: 5,
    used_count: 2,
    start_at: new Date(Date.now() - 60_000),
    end_at: new Date(Date.now() + 60 * 60_000),
    is_active: true,
    evaluated_at: new Date(),
  };
  configureCreateTransaction({
    voucher,
    bookingTotalPrice: "24000.00",
  });

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestBody({ voucher_code: "  save10 " })),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.data.total_price, "24000.00");
  assert.equal(body.data.voucher_code, "SAVE10");
  const reserve = transactionCalls.find((call) =>
    call.sql.includes("FROM vouchers")
  );
  assert.equal(reserve.params[0], "SAVE10");
  const increment = transactionCalls.find((call) =>
    call.sql.includes("SET used_count = used_count + 1")
  );
  const bookingInsert = transactionCalls.find((call) =>
    call.sql.includes("INSERT INTO bookings")
  );
  assert.ok(increment);
  assert.equal(bookingInsert.params[5], "24000.00");
  assert.equal(
    bookingInsert.params[7],
    "936fd05a-c130-40e7-9e0a-71d8084c77c4"
  );
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("failed booking rolls back its voucher quota reservation", async () => {
  const voucher = {
    id: "936fd05a-c130-40e7-9e0a-71d8084c77c4",
    code: "SAVE10",
    discount_type: "fixed",
    discount_value: "5000.00",
    minimum_transaction: "0.00",
    max_discount: null,
    usage_limit: 5,
    used_count: 0,
    start_at: new Date(Date.now() - 60_000),
    end_at: new Date(Date.now() + 60 * 60_000),
    is_active: true,
    evaluated_at: new Date(),
  };
  configureCreateTransaction({ voucher, schedules: [] });

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestBody({ voucher_code: "SAVE10" })),
  });

  assert.equal(response.status, 409);
  assert.ok(transactionCalls.some((call) =>
    call.sql.includes("SET used_count = used_count + 1")
  ));
  assert.equal(
    transactionCalls.some((call) => call.sql.includes("INSERT INTO bookings")),
    false
  );
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("rejects malformed, duplicate, or past booking input before database access", async () => {
  const token = createToken("customer");
  const baseBody = createRequestBody();
  const invalidCases = [
    { ...baseBody, items: [] },
    {
      ...baseBody,
      items: [
        { service_id: serviceId },
        { service_id: serviceId, quantity: 2 },
      ],
    },
    { ...baseBody, start_at: "2026-11-19T10:00:30Z" },
    { ...baseBody, start_at: new Date(Date.now() - 60_000).toISOString() },
  ];

  for (const body of invalidCases) {
    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(connectCalls, 0);
});

test("requires a customer token to create bookings", async () => {
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createRequestBody()),
  };
  const unauthenticated = await fetch(`${baseUrl}/api/bookings`, request);
  assert.equal(unauthenticated.status, 401);

  const barber = await fetch(`${baseUrl}/api/bookings`, {
    ...request,
    headers: {
      ...request.headers,
      Authorization: `Bearer ${createToken("barber", barberUserId)}`,
    },
  });
  assert.equal(barber.status, 403);
  assert.equal(connectCalls, 0);
});

test("rejects missing barber, inactive customer, unavailable service, and missing schedule", async () => {
  const cases = [
    {
      options: { barber: null },
      expectedStatus: 404,
    },
    {
      options: {
        barber: { id: barberId, is_available: false, user_is_active: true },
      },
      expectedStatus: 409,
    },
    {
      options: { customerExists: false },
      expectedStatus: 403,
    },
    {
      options: { services: [] },
      expectedStatus: 409,
    },
    {
      options: { schedules: [] },
      expectedStatus: 409,
    },
  ];

  for (const { options, expectedStatus } of cases) {
    configureCreateTransaction(options);
    const response = await fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createToken("customer")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createRequestBody()),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
  }
});

test("rejects a booking whose interval overlaps an existing booking", async () => {
  configureCreateTransaction({ conflicts: [{ id: "occupied-booking" }] });

  const response = await fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createToken("customer")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createRequestBody()),
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.match(body.message, /sudah terisi/);
  assert.equal(
    transactionCalls.some((call) => call.sql.includes("INSERT INTO bookings")),
    false
  );
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("booking list is scoped to the current customer, assigned barber, or admin", async () => {
  queryHandler = async () => ({
    rows: [{ id: bookingId, status: "pending" }],
  });

  const customerResponse = await fetch(`${baseUrl}/api/bookings`, {
    headers: { Authorization: `Bearer ${createToken("customer")}` },
  });
  assert.equal(customerResponse.status, 200);
  assert.match(queryCalls[0][0], /b\.customer_id = \$1/);
  assert.deepEqual(queryCalls[0][1], [customerId]);

  queryCalls = [];
  const barberResponse = await fetch(`${baseUrl}/api/bookings`, {
    headers: {
      Authorization: `Bearer ${createToken("barber", barberUserId)}`,
    },
  });
  assert.equal(barberResponse.status, 200);
  assert.match(queryCalls[0][0], /SELECT id FROM barbers WHERE user_id = \$1/);
  assert.deepEqual(queryCalls[0][1], [barberUserId]);

  queryCalls = [];
  const adminResponse = await fetch(`${baseUrl}/api/bookings`, {
    headers: { Authorization: `Bearer ${createToken("admin")}` },
  });
  assert.equal(adminResponse.status, 200);
  assert.doesNotMatch(queryCalls[0][0], /WHERE b\.customer_id/);
  assert.deepEqual(queryCalls[0][1], []);
});

test("customer sees booking details with item snapshots and cannot see another booking", async () => {
  queryHandler = async (sql, params) => {
    if (sql.includes("booking_code")) {
      return { rows: [{ id: bookingId, customer_id: customerId }] };
    }
    if (sql.includes("FROM booking_items")) {
      return { rows: [{ service_name: "Haircut", subtotal: "25000.00" }] };
    }
    return { rows: [] };
  };

  const response = await fetch(`${baseUrl}/api/bookings/${bookingId}`, {
    headers: { Authorization: `Bearer ${createToken("customer")}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.items[0].service_name, "Haircut");
  assert.deepEqual(queryCalls[0][1], [bookingId, customerId]);

  queryHandler = async () => ({ rows: [] });
  const hiddenResponse = await fetch(`${baseUrl}/api/bookings/${bookingId}`, {
    headers: {
      Authorization: `Bearer ${createToken("customer", barberUserId)}`,
    },
  });
  assert.equal(hiddenResponse.status, 404);
});

test("customer cancellation is limited to pending or confirmed future bookings", async () => {
  const statusToReturn = { value: "confirmed" };
  const voucherId = "936fd05a-c130-40e7-9e0a-71d8084c77c4";
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("SELECT barber_id FROM bookings")) {
      return { rows: [{ barber_id: barberId }] };
    }
    if (sql.includes("FROM barbers") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: barberId, user_id: barberUserId }] };
    }
    if (sql.includes("customer_id = $2") && sql.includes("FOR UPDATE")) {
      return {
        rows: [{
          id: bookingId,
          status: statusToReturn.value,
          voucher_id: voucherId,
        }],
      };
    }
    if (sql.includes("SET status = 'cancelled'")) {
      return { rows: [{ id: bookingId, status: "cancelled" }] };
    }
    if (sql.includes("SET used_count = used_count - 1")) {
      return { rows: [{ id: voucherId }] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/bookings/${bookingId}/cancel`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("customer")}` },
  });
  assert.equal(response.status, 200);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
  assert.equal(
    transactionCalls.filter((call) =>
      call.sql.includes("SET used_count = used_count - 1")
    ).length,
    1
  );

  transactionCalls = [];
  statusToReturn.value = "in_progress";
  const rejected = await fetch(`${baseUrl}/api/bookings/${bookingId}/cancel`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${createToken("customer")}` },
  });
  assert.equal(rejected.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
  assert.equal(
    transactionCalls.some((call) =>
      call.sql.includes("SET used_count = used_count - 1")
    ),
    false
  );
});

test("barber status changes require ownership and a valid state transition", async () => {
  let assignedUserId = barberUserId;
  let currentStatus = "pending";
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("SELECT barber_id FROM bookings")) {
      return { rows: [{ barber_id: barberId }] };
    }
    if (sql.includes("FROM barbers") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: barberId, user_id: assignedUserId }] };
    }
    if (sql.includes("SELECT id, status, start_at")) {
      return { rows: [{ id: bookingId, status: currentStatus, start_at: futureStartAt() }] };
    }
    if (sql.includes("SET status = $2")) {
      return { rows: [{ id: bookingId, status: "confirmed" }] };
    }
    if (sql.includes("SELECT id FROM queues WHERE booking_id = $1")) {
      return { rows: [] };
    }
    if (sql.includes("FROM bookings b") && sql.includes("FOR UPDATE")) {
      return {
        rows: [{
          id: bookingId,
          barber_id: barberId,
          customer_id: customerId,
          start_at: futureStartAt(),
          status: "confirmed",
        }],
      };
    }
    if (sql.includes("SELECT id FROM barbers WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: barberId }] };
    }
    if (sql.includes("COALESCE(MAX(queue_number)")) {
      return { rows: [{ next_number: 1 }] };
    }
    if (sql.includes("INSERT INTO queues")) {
      return { rows: [{ id: "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe" }] };
    }
    if (sql.includes("FROM queues q") && sql.includes("duration_minutes")) {
      return { rows: [] };
    }
    if (sql.includes("FROM queues q") && sql.includes("WHERE q.id = $1")) {
      return {
        rows: [{
          id: "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe",
          booking_id: bookingId,
          barber_id: barberId,
          queue_date: "2026-11-21",
          queue_number: 1,
          status: "waiting",
          customer_id: customerId,
        }],
      };
    }
    if (sql.includes("FROM booking_items") && sql.includes("WHERE booking_id = $1")) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const path = `${baseUrl}/api/bookings/${bookingId}/status`;
  const invalidStatus = await fetch(path, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${createToken("admin")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "unrecognized" }),
  });
  assert.equal(invalidStatus.status, 400);
  assert.equal(connectCalls, 0);

  const confirmed = await fetch(path, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${createToken("barber", barberUserId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal(confirmed.status, 200);

  transactionCalls = [];
  assignedUserId = "5a22d7d2-8b62-4b79-9d4c-6d3e8bd92e42";
  const notAssigned = await fetch(path, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${createToken("barber", barberUserId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "confirmed" }),
  });
  assert.equal(notAssigned.status, 404);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");

  transactionCalls = [];
  assignedUserId = barberUserId;
  currentStatus = "pending";
  const invalidTransition = await fetch(path, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${createToken("admin")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(invalidTransition.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");
});

test("completed booking awards points to its customer in the booking transaction", async () => {
  useMockTransaction(async (sql, params) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("SELECT barber_id FROM bookings")) {
      return { rows: [{ barber_id: barberId }] };
    }
    if (sql.includes("FROM barbers") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: barberId, user_id: barberUserId }] };
    }
    if (sql.includes("SELECT id, status, start_at")) {
      return {
        rows: [{
          id: bookingId,
          status: "in_progress",
          start_at: new Date(Date.now() - 60_000).toISOString(),
          has_started: true,
        }],
      };
    }
    if (sql.includes("SET status = $2")) {
      return { rows: [{ id: bookingId, status: "completed" }] };
    }
    if (sql.includes("FROM bookings b") && sql.includes("total_price")) {
      return { rows: [{ customer_id: customerId, total_price: "25999.99" }] };
    }
    if (sql.includes("INSERT INTO loyalty_points")) {
      return { rows: [{ booking_id: params[1], points: params[2] }] };
    }
    if (sql.includes("SELECT queue_date, barber_id")) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const response = await fetch(`${baseUrl}/api/bookings/${bookingId}/status`, {
    method: "PATCH",
    headers: {
      ...adminHeaders(),
    },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(response.status, 200);
  const earn = transactionCalls.find((call) => call.sql.includes("INSERT INTO loyalty_points"));
  assert.deepEqual(earn.params, [customerId, bookingId, 2]);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
});

test("admin can mark a booking no-show only after its start time", async () => {
  let bookingStart = futureStartAt();
  useMockTransaction(async (sql) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.includes("SELECT barber_id FROM bookings")) {
      return { rows: [{ barber_id: barberId }] };
    }
    if (sql.includes("FROM barbers") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: barberId, user_id: barberUserId }] };
    }
    if (sql.includes("SELECT id, status, start_at")) {
      return {
        rows: [
          {
            id: bookingId,
            status: "confirmed",
            start_at: bookingStart,
            voucher_id: "936fd05a-c130-40e7-9e0a-71d8084c77c4",
            has_started: new Date(bookingStart).getTime() <= Date.now(),
          },
        ],
      };
    }
    if (sql.includes("SET status = $2")) {
      return { rows: [{ id: bookingId, status: "no_show" }] };
    }
    return { rows: [] };
  });

  const path = `${baseUrl}/api/bookings/${bookingId}/status`;
  const request = () =>
    fetch(path, {
      method: "PATCH",
      headers: {
        ...adminHeaders(),
      },
      body: JSON.stringify({ status: "no_show" }),
    });

  const tooEarly = await request();
  assert.equal(tooEarly.status, 409);
  assert.equal(transactionCalls.at(-1).sql, "ROLLBACK");

  transactionCalls = [];
  bookingStart = new Date(Date.now() - 60_000).toISOString();
  const afterStart = await request();
  assert.equal(afterStart.status, 200);
  assert.equal(transactionCalls.at(-1).sql, "COMMIT");
  assert.equal(
    transactionCalls.some((call) =>
      call.sql.includes("SET used_count = used_count - 1")
    ),
    false
  );
});

test("concurrent requests for the same barber and time cannot double-book", async () => {
  let lockTail = Promise.resolve();
  const committedBookings = [];
  const transactionHistory = [];

  pool.connect = async () => {
    let releaseBarberLock;
    let pendingBooking = null;
    const queries = [];
    transactionHistory.push(queries);

    return {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          if (pendingBooking) {
            committedBookings.push(pendingBooking);
          }
          if (releaseBarberLock) {
            releaseBarberLock();
          }
          return { rows: [] };
        }
        if (sql.includes("role = 'customer'")) {
          return { rows: [{ id: customerId }] };
        }
        if (sql.includes("FOR UPDATE OF b, u")) {
          const previous = lockTail;
          lockTail = new Promise((resolve) => {
            releaseBarberLock = resolve;
          });
          await previous;
          return {
            rows: [
              { id: barberId, is_available: true, user_is_active: true },
            ],
          };
        }
        if (sql.includes("FROM services")) {
          return {
            rows: [
              {
                id: serviceId,
                service_name: "Haircut",
                price: "25000.00",
                duration_minutes: 30,
              },
            ],
          };
        }
        if (sql.includes("FROM schedules")) {
          return { rows: [{ id: "available-schedule" }] };
        }
        if (sql.includes("FROM bookings") && sql.includes("status IN")) {
          const start = new Date(params[1]).getTime();
          const end = new Date(params[2]).getTime();
          return {
            rows: committedBookings.filter(
              (booking) =>
                new Date(booking.startAt).getTime() < end &&
                new Date(booking.endAt).getTime() > start
            ),
          };
        }
        if (sql.includes("INSERT INTO bookings")) {
          pendingBooking = {
            id: crypto.randomUUID(),
            startAt: params[3],
            endAt: params[4],
          };
          return { rows: [{ id: pendingBooking.id }] };
        }
        if (sql.includes("INSERT INTO booking_items")) {
          return { rows: [] };
        }
        if (sql.includes("booking_code")) {
          return { rows: [{ id: pendingBooking.id, booking_code: "CK-CONCURRENT" }] };
        }
        if (sql.includes("FROM booking_items")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
  };

  const request = () =>
    fetch(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createToken("customer")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createRequestBody()),
    });

  const responses = await Promise.all([request(), request()]);
  const statuses = responses.map((response) => response.status).sort();

  assert.deepEqual(statuses, [201, 409]);
  assert.equal(committedBookings.length, 1);
  assert.equal(
    transactionHistory.every((queries) =>
      queries.some((query) => query.sql.includes("FOR UPDATE OF b, u"))
    ),
    true
  );
});

test("Swagger documents booking operations, role restrictions, and payloads", () => {
  const paths = swaggerSpec.paths;
  assert.ok(paths["/api/bookings"].get);
  assert.ok(paths["/api/bookings"].post);
  assert.ok(paths["/api/bookings/{id}"].get);
  assert.ok(paths["/api/bookings/{id}/cancel"].patch);
  assert.ok(paths["/api/bookings/{id}/status"].patch);
  assert.ok(swaggerSpec.components.schemas.CreateBookingRequest);
  assert.ok(swaggerSpec.components.schemas.BookingStatusRequest);
  assert.deepEqual(paths["/api/bookings"].post.security, [{ bearerAuth: [] }]);
});
