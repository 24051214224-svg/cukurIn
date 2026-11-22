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

const userId = "00fb6c12-a13b-4a63-a7f3-cfe1b4cde18d";
const createToken = (role) =>
  jwt.sign({ id: userId, role }, testJwtSecret);

const recommendationPath = (faceShape, hairType) =>
  `/api/hairstyles/recommendations?face_shape=${faceShape}&hair_type=${hairType}`;

const recommendation = (overrides = {}) => ({
  id: "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e8",
  hairstyle_name: "Quiff",
  description: "Rambut bagian depan dibuat lebih bervolume.",
  image_url: null,
  face_shape: "oval",
  hair_type: "wavy",
  ...overrides,
});

const requestAs = (path, role) =>
  fetch(`${baseUrl}${path}`, {
    headers: role
      ? { Authorization: `Bearer ${createToken(role)}` }
      : undefined,
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

test("customer can access recommendations while unauthenticated and non-customer users cannot", async () => {
  const path = recommendationPath("oval", "wavy");
  const unauthenticated = await requestAs(path);
  assert.equal(unauthenticated.status, 401);
  assert.equal(queryCalls.length, 0);

  const barber = await requestAs(path, "barber");
  assert.equal(barber.status, 403);
  assert.equal(queryCalls.length, 0);

  const exact = recommendation();
  const fallback = recommendation({
    id: "9271c3fb-e0f3-4f82-b830-488594b4eaf3",
    hairstyle_name: "Undercut",
    face_shape: "oval",
    hair_type: "all",
  });
  queryHandler = async () => ({ rows: [exact, fallback] });

  const customer = await requestAs(path, "customer");
  const body = await customer.json();

  assert.equal(customer.status, 200);
  assert.deepEqual(body.data, [exact, fallback]);
  assert.deepEqual(queryCalls[0][1], ["oval", "wavy"]);
  assert.deepEqual(Object.keys(body.data[0]), [
    "id",
    "hairstyle_name",
    "description",
    "image_url",
    "face_shape",
    "hair_type",
  ]);
});

test("rejects missing, invalid, or extra recommendation query fields", async () => {
  const invalidPaths = [
    "/api/hairstyles/recommendations?face_shape=oval",
    recommendationPath("all", "wavy"),
    recommendationPath("oval", "all"),
    `${recommendationPath("oval", "wavy")}&admin=true`,
  ];

  for (const path of invalidPaths) {
    const response = await requestAs(path, "customer");
    assert.equal(response.status, 400);
  }
  assert.equal(queryCalls.length, 0);
});

test("queries only active hairstyles and uses face_shape all as a fallback", async () => {
  const faceFallback = recommendation({
    face_shape: "all",
    hair_type: "wavy",
  });
  queryHandler = async () => ({ rows: [faceFallback] });

  const response = await requestAs(
    recommendationPath("diamond", "wavy"),
    "customer"
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [faceFallback]);
  assert.match(queryCalls[0][0], /is_active = TRUE/);
  assert.match(queryCalls[0][0], /face_shape IN \(\$1, 'all'\)/);
});

test("uses hair_type all as a fallback", async () => {
  const hairFallback = recommendation({
    face_shape: "oval",
    hair_type: "all",
  });
  queryHandler = async () => ({ rows: [hairFallback] });

  const response = await requestAs(
    recommendationPath("oval", "curly"),
    "customer"
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [hairFallback]);
  assert.match(queryCalls[0][0], /hair_type IN \(\$2, 'all'\)/);
});

test("returns specific matches before fallback matches and supports no results", async () => {
  const exact = recommendation();
  const faceFallback = recommendation({
    id: "9271c3fb-e0f3-4f82-b830-488594b4eaf3",
    hairstyle_name: "Face fallback",
    face_shape: "all",
    hair_type: "wavy",
  });
  const hairFallback = recommendation({
    id: "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8e9",
    hairstyle_name: "Hair fallback",
    face_shape: "oval",
    hair_type: "all",
  });
  const generalFallback = recommendation({
    id: "69877e2c-2a7b-4bd0-8d15-c4b74b4bb8f0",
    hairstyle_name: "General fallback",
    face_shape: "all",
    hair_type: "all",
  });
  queryHandler = async () => ({
    rows: [exact, hairFallback, faceFallback, generalFallback],
  });

  const response = await requestAs(
    recommendationPath("oval", "wavy"),
    "customer"
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, [exact, hairFallback, faceFallback, generalFallback]);
  assert.match(queryCalls[0][0], /ORDER BY/);
  assert.match(queryCalls[0][0], /\(face_shape = \$1 AND hair_type = \$2\) DESC/);

  queryHandler = async () => ({ rows: [] });
  const noMatches = await requestAs(
    recommendationPath("oblong", "coily"),
    "customer"
  );
  const emptyBody = await noMatches.json();
  assert.equal(noMatches.status, 200);
  assert.deepEqual(emptyBody.data, []);
});

test("Swagger declares customer-only hairstyle recommendation query and response", () => {
  const endpoint =
    swaggerSpec.paths["/api/hairstyles/recommendations"].get;

  assert.deepEqual(
    endpoint.parameters.map((parameter) => parameter.name),
    ["face_shape", "hair_type"]
  );
  assert.deepEqual(endpoint.security, [{ bearerAuth: [] }]);
  assert.equal(endpoint.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/HairstyleRecommendationResponse");
});
