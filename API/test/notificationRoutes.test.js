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
const originalQuery = pool.query;

const customerId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberId = "20fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const adminId = "30fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const otherUserId = "40fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const notificationId = "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe";

const createToken = (role, id) => jwt.sign({ id, role }, testJwtSecret);

const requestAs = (path, role, id, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(role ? { Authorization: `Bearer ${createToken(role, id)}` } : {}),
    },
  });

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  queryCalls = [];
  queryHandler = async () => ({ rows: [] });
  pool.query = (...args) => {
    queryCalls.push(args);
    return queryHandler(...args);
  };
});

afterEach(() => {
  pool.query = originalQuery;
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

test("customer, barber, and admin each list only their own notifications", async () => {
  const notification = {
    id: notificationId,
    title: "Test",
    message: "Message",
    notification_type: "booking",
    is_read: false,
    created_at: "2026-11-20T14:00:00.000Z",
  };
  queryHandler = async () => ({ rows: [notification] });

  for (const [role, userId] of [
    ["customer", customerId],
    ["barber", barberId],
    ["admin", adminId],
  ]) {
    const response = await requestAs(
      "/api/notifications",
      role,
      userId
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.notifications, [notification]);
    assert.match(queryCalls.at(-1)[0], /WHERE user_id = \$1/);
    assert.deepEqual(queryCalls.at(-1)[1], [userId, 50, 0]);
    assert.match(queryCalls.at(-1)[0], /ORDER BY created_at DESC, id DESC/);
  }
});

test("notification list validates and applies bounded pagination", async () => {
  const response = await requestAs(
    "/api/notifications?limit=20&offset=40",
    "customer",
    customerId
  );
  assert.equal(response.status, 200);
  assert.deepEqual(queryCalls[0][1], [customerId, 20, 40]);

  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?offset=-1",
    "?offset=1000001",
    "?user_id=" + otherUserId,
  ]) {
    const invalid = await requestAs(
      `/api/notifications${query}`,
      "customer",
      customerId
    );
    assert.equal(invalid.status, 400);
  }
  assert.equal(queryCalls.length, 1);
});

test("users can mark only their own notification as read", async () => {
  queryHandler = async (_sql, params) =>
    params[1] === customerId
      ? { rows: [{ id: notificationId, is_read: true }] }
      : { rows: [] };

  const own = await requestAs(
    `/api/notifications/${notificationId}/read`,
    "customer",
    customerId,
    { method: "PATCH" }
  );
  assert.equal(own.status, 200);
  assert.deepEqual(queryCalls[0][1], [notificationId, customerId]);
  assert.match(queryCalls[0][0], /WHERE id = \$1 AND user_id = \$2/);

  const other = await requestAs(
    `/api/notifications/${notificationId}/read`,
    "customer",
    otherUserId,
    { method: "PATCH" }
  );
  assert.equal(other.status, 404);
  assert.equal((await other.json()).message, "Notifikasi tidak ditemukan");
});

test("notification endpoints require an authenticated supported role and valid IDs", async () => {
  const unauthenticated = await requestAs("/api/notifications", null);
  assert.equal(unauthenticated.status, 401);

  const unsupportedRole = await requestAs(
    "/api/notifications",
    "guest",
    customerId
  );
  assert.equal(unsupportedRole.status, 403);

  const invalidId = await requestAs(
    "/api/notifications/not-a-uuid/read",
    "admin",
    adminId,
    { method: "PATCH" }
  );
  assert.equal(invalidId.status, 400);
});

test("Swagger documents notification list and mark-read endpoints", () => {
  assert.ok(swaggerSpec.paths["/api/notifications"].get);
  assert.ok(swaggerSpec.paths["/api/notifications/{id}/read"].patch);
  assert.deepEqual(
    swaggerSpec.paths["/api/notifications"].get.security,
    [{ bearerAuth: [] }]
  );
});
