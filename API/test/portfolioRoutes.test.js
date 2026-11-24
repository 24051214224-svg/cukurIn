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
const { portfolioWriteSchema } = require("../src/validators/portfolioValidator");

let server;
let baseUrl;
let queryHandler;
let queryCalls;
const originalQuery = pool.query;

const barberUserId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const otherBarberUserId = "20fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const barberId = "9271c3fb-e0f3-4f82-b830-488594b4eaf3";
const portfolioId = "5e0e58e8-a7e4-41af-b77e-fc5fe10eb5fe";
const imageUrl = "https://images.example.invalid/haircut.jpg";

test("portfolio image URLs accept only absolute HTTP and HTTPS URLs", () => {
  const validUrls = [
    "https://images.example.invalid/haircut.jpg",
    "http://images.example.invalid/haircut.jpg",
  ];
  const invalidUrls = [
    "images.example.invalid/haircut.jpg",
    "javascript:alert('do-not-reflect-this')",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "file:///tmp/haircut.jpg",
    "ftp://images.example.invalid/haircut.jpg",
  ];

  for (const image_url of validUrls) {
    assert.equal(
      portfolioWriteSchema.safeParse({ title: "Fade", image_url }).success,
      true
    );
  }

  for (const image_url of invalidUrls) {
    const result = portfolioWriteSchema.safeParse({
      title: "Fade",
      image_url,
    });

    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result.error.issues).includes(image_url), false);
  }
});

const createToken = (role, id = barberUserId) =>
  jwt.sign({ id, role }, testJwtSecret);

const portfolio = (overrides = {}) => ({
  id: portfolioId,
  barber_id: barberId,
  title: "Fade",
  description: null,
  image_url: imageUrl,
  created_at: "2026-11-20T14:00:00.000Z",
  updated_at: "2026-11-20T14:00:00.000Z",
  ...overrides,
});

const requestAs = (path, role, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(role ? { Authorization: `Bearer ${createToken(role)}` } : {}),
    },
  });

const jsonRequest = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
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

test("customers can list only the requested barber's public portfolios", async () => {
  const expected = [portfolio()];
  queryHandler = async (sql) => {
    if (sql.includes("FROM barbers b")) return { rows: [{ id: barberId }] };
    return { rows: expected };
  };

  const response = await requestAs(`/api/barbers/${barberId}/portfolios`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, expected);
  assert.deepEqual(queryCalls.map((call) => call[1]), [[barberId], [barberId]]);
  assert.match(queryCalls[1][0], /WHERE barber_id = \$1/);
});

test("customers can get a portfolio detail and receive 404 when it is missing", async () => {
  queryHandler = async (_sql, params) => ({
    rows: params[1] === portfolioId ? [portfolio()] : [],
  });

  const response = await requestAs(
    `/api/barbers/${barberId}/portfolios/${portfolioId}`
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, portfolio());
  assert.deepEqual(queryCalls[0][1], [barberId, portfolioId]);
  assert.match(queryCalls[0][0], /WHERE b\.id = \$1/);
  assert.match(queryCalls[0][0], /AND p\.id = \$2/);

  queryHandler = async () => ({ rows: [] });
  const missing = await requestAs(
    `/api/barbers/${barberId}/portfolios/${portfolioId}`
  );
  assert.equal(missing.status, 404);
});

test("portfolio management requires a barber token and validates title and URL", async () => {
  const payload = { title: "Fade", image_url: imageUrl };
  const unauthenticated = await requestAs(
    "/api/portfolios",
    null,
    jsonRequest("POST", payload)
  );
  assert.equal(unauthenticated.status, 401);

  for (const role of ["customer", "admin"]) {
    const forbidden = await requestAs(
      "/api/portfolios",
      role,
      jsonRequest("POST", payload)
    );
    assert.equal(forbidden.status, 403);
  }
  assert.equal(queryCalls.length, 0);

  for (const invalidPayload of [
    { title: " ".repeat(2), image_url: imageUrl },
    { title: "x".repeat(151), image_url: imageUrl },
    { title: "Fade", image_url: "not-a-url" },
  ]) {
    const invalid = await requestAs(
      "/api/portfolios",
      "barber",
      jsonRequest("POST", invalidPayload)
    );
    assert.equal(invalid.status, 400);
  }
  assert.equal(queryCalls.length, 0);
});

test("barber creates a portfolio linked to their barber profile", async () => {
  const expected = portfolio();
  queryHandler = async (_sql, params) => {
    assert.deepEqual(params, [barberUserId, "Fade", null, imageUrl]);
    return { rows: [expected] };
  };

  const response = await requestAs(
    "/api/portfolios",
    "barber",
    jsonRequest("POST", { title: "Fade", image_url: imageUrl })
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.data, expected);
  assert.match(queryCalls[0][0], /b\.user_id = \$1/);
  assert.match(queryCalls[0][0], /INSERT INTO portfolios/);
});

test("barber updates only a portfolio owned through their user ID", async () => {
  const expected = portfolio({ title: "Updated fade", description: "" });
  queryHandler = async (_sql, params) => {
    assert.deepEqual(params, [
      portfolioId,
      barberUserId,
      "Updated fade",
      "",
      imageUrl,
    ]);
    return { rows: [expected] };
  };

  const response = await requestAs(
    `/api/portfolios/${portfolioId}`,
    "barber",
    jsonRequest("PUT", {
      title: "Updated fade",
      description: "",
      image_url: imageUrl,
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, expected);
  assert.match(queryCalls[0][0], /p\.barber_id = b\.id/);
  assert.match(queryCalls[0][0], /b\.user_id = \$2/);

  queryHandler = async (_sql, params) => {
    assert.equal(params[1], barberUserId);
    return { rows: [] };
  };
  const otherBarberPortfolio = await requestAs(
    `/api/portfolios/${portfolioId}`,
    "barber",
    jsonRequest("PUT", { title: "Updated", image_url: imageUrl })
  );
  assert.equal(otherBarberPortfolio.status, 404);
});

test("barber deletes only a portfolio owned through their user ID", async () => {
  queryHandler = async (_sql, params) => {
    assert.deepEqual(params, [portfolioId, barberUserId]);
    return { rows: [portfolio()] };
  };

  const response = await requestAs(
    `/api/portfolios/${portfolioId}`,
    "barber",
    { method: "DELETE" }
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, portfolio());
  assert.match(queryCalls[0][0], /p\.barber_id = b\.id/);
  assert.match(queryCalls[0][0], /b\.user_id = \$2/);

  queryHandler = async () => ({ rows: [] });
  const otherBarberPortfolio = await requestAs(
    `/api/portfolios/${portfolioId}`,
    "barber",
    { method: "DELETE" }
  );
  assert.equal(otherBarberPortfolio.status, 404);
});

test("Swagger documents portfolio read and barber-management endpoints", () => {
  assert.ok(swaggerSpec.paths["/api/barbers/{barberId}/portfolios"].get);
  assert.ok(
    swaggerSpec.paths["/api/barbers/{barberId}/portfolios/{portfolioId}"].get
  );
  assert.ok(swaggerSpec.paths["/api/portfolios"].post);
  assert.ok(swaggerSpec.paths["/api/portfolios/{id}"].put);
  assert.ok(swaggerSpec.paths["/api/portfolios/{id}"].delete);
  assert.deepEqual(
    swaggerSpec.paths["/api/portfolios/{id}"].put.security,
    [{ bearerAuth: [] }]
  );
});
