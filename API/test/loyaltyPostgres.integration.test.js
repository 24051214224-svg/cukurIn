const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const integrationJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
const previousRupiahPerPoint = process.env.LOYALTY_RUPIAH_PER_POINT;
process.env.JWT_SECRET = integrationJwtSecret;
process.env.LOYALTY_RUPIAH_PER_POINT = "10000";

const app = require("../src/app");
const pool = require("../src/config/database");
const { awardCompletedBookingPoints } = require("../src/services/loyaltyService");

const runIntegration =
  process.env.RUN_POSTGRES_LOYALTY_INTEGRATION === "1";
const createToken = (role, id) =>
  jwt.sign({ id, role }, integrationJwtSecret);

test("PostgreSQL loyalty integration: earn, scoped reads, redemption, and concurrency", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_LOYALTY_INTEGRATION=1 to run PostgreSQL loyalty integration tests"
    : false,
}, async () => {
  const suffix = crypto.randomUUID();
  const ids = { userIds: [], bookingIds: [] };
  let cleanupNeeded = false;
  let server;

  const insertOne = async (client, sql, params) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  };

  const createBooking = async (
    client,
    customerId,
    barberId,
    status,
    totalPrice,
    startAt
  ) => {
    const endAt = new Date(new Date(startAt).getTime() + 30 * 60_000);
    const bookingCode = `LOY-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const result = await insertOne(
      client,
      `INSERT INTO bookings (
         customer_id, barber_id, booking_code, start_at, end_at, status, total_price
       )
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::numeric)
       RETURNING id`,
      [customerId, barberId, bookingCode, startAt, endAt.toISOString(), status, totalPrice]
    );
    ids.bookingIds.push(result.id);
    return result.id;
  };

  const send = async (path, role, userId, method = "GET", body) => {
    const headers = { Authorization: `Bearer ${createToken(role, userId)}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };

  let baseUrl;
  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");

      const customer = await insertOne(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'customer')
         RETURNING id`,
        [`Loyalty Customer ${suffix}`, `loyalty-${suffix}@example.invalid`, `9${crypto.randomBytes(8).toString("hex")}`]
      );
      ids.userIds.push(customer.id);

      const otherCustomer = await insertOne(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'customer')
         RETURNING id`,
        [`Loyalty Other ${suffix}`, `loyalty-other-${suffix}@example.invalid`, `8${crypto.randomBytes(8).toString("hex")}`]
      );
      ids.userIds.push(otherCustomer.id);

      const barberUser = await insertOne(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'barber')
         RETURNING id`,
        [`Loyalty Barber ${suffix}`, `loyalty-barber-${suffix}@example.invalid`, `7${crypto.randomBytes(8).toString("hex")}`]
      );
      ids.userIds.push(barberUser.id);

      const barber = await insertOne(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary loyalty integration test', TRUE)
         RETURNING id`,
        [barberUser.id]
      );
      ids.barberId = barber.id;
      ids.customerId = customer.id;
      ids.otherCustomerId = otherCustomer.id;
      ids.barberUserId = barberUser.id;

      const futureStart = new Date(Date.now() + 60 * 60_000).toISOString();
      const pastStart = new Date(Date.now() - 60 * 60_000).toISOString();
      ids.bookingId = await createBooking(
        setup, customer.id, barber.id, "in_progress", "25999.99", futureStart
      );
      ids.queueBookingId = await createBooking(
        setup, customer.id, barber.id, "in_progress", "10000.00", futureStart
      );
      ids.noShowBookingId = await createBooking(
        setup, customer.id, barber.id, "confirmed", "50000.00", pastStart
      );
      ids.cancelledBookingId = await createBooking(
        setup, customer.id, barber.id, "confirmed", "50000.00", futureStart
      );
      ids.pendingBookingId = await createBooking(
        setup, customer.id, barber.id, "pending", "50000.00", futureStart
      );

      const queue = await insertOne(
        setup,
        `INSERT INTO queues (booking_id, barber_id, queue_date, queue_number, status)
         VALUES ($1, $2, CURRENT_DATE + 2, 1, 'serving')
         RETURNING id`,
        [ids.queueBookingId, barber.id]
      );
      ids.queueId = queue.id;

      await setup.query("COMMIT");
      cleanupNeeded = true;
    } catch (error) {
      await setup.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      setup.release();
    }

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const bookingCompletion = await send(
      `/api/bookings/${ids.bookingId}/status`,
      "admin",
      ids.barberUserId,
      "PATCH",
      { status: "completed" }
    );
    assert.equal(bookingCompletion.status, 200);

    const queueCompletion = await send(
      `/api/queues/${ids.queueId}/complete`,
      "barber",
      ids.barberUserId,
      "PATCH"
    );
    assert.equal(queueCompletion.status, 200);

    const noShow = await send(
      `/api/bookings/${ids.noShowBookingId}/status`,
      "admin",
      ids.barberUserId,
      "PATCH",
      { status: "no_show" }
    );
    assert.equal(noShow.status, 200);

    const cancelled = await send(
      `/api/bookings/${ids.cancelledBookingId}/status`,
      "admin",
      ids.barberUserId,
      "PATCH",
      { status: "cancelled" }
    );
    assert.equal(cancelled.status, 200);

    const duplicateClient = await pool.connect();
    try {
      await duplicateClient.query("BEGIN");
      await awardCompletedBookingPoints(duplicateClient, ids.bookingId);
      await awardCompletedBookingPoints(duplicateClient, ids.bookingId);
      await duplicateClient.query("COMMIT");
    } catch (error) {
      await duplicateClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      duplicateClient.release();
    }

    const pendingClient = await pool.connect();
    try {
      await pendingClient.query("BEGIN");
      assert.equal(
        await awardCompletedBookingPoints(pendingClient, ids.pendingBookingId),
        null
      );
      await pendingClient.query("COMMIT");
    } catch (error) {
      await pendingClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      pendingClient.release();
    }

    const earnings = await pool.query(
      `SELECT booking_id, user_id, points
       FROM loyalty_points
       WHERE booking_id = ANY($1::uuid[])
         AND transaction_type = 'earn'
       ORDER BY booking_id`,
      [ids.bookingIds]
    );
    assert.equal(earnings.rows.length, 2);
    assert.deepEqual(
      earnings.rows.map((row) => Number(row.points)).sort(),
      [1, 2]
    );
    assert.ok(earnings.rows.every((row) => row.user_id === ids.customerId));

    const balanceResponse = await send(
      "/api/loyalty/balance",
      "customer",
      ids.customerId
    );
    assert.equal(balanceResponse.status, 200);
    assert.equal((await balanceResponse.json()).data.balance, 3);

    const historyResponse = await send(
      "/api/loyalty/history",
      "customer",
      ids.customerId
    );
    const historyBody = await historyResponse.json();
    assert.equal(historyResponse.status, 200);
    assert.equal(historyBody.data.transactions.length, 2);

    const crossCustomerBalance = await send(
      `/api/loyalty/balance?user_id=${ids.customerId}`,
      "customer",
      ids.otherCustomerId
    );
    assert.equal(crossCustomerBalance.status, 200);
    assert.equal((await crossCustomerBalance.json()).data.balance, 0);

    const crossCustomerHistory = await send(
      `/api/loyalty/history?user_id=${ids.customerId}`,
      "customer",
      ids.otherCustomerId
    );
    assert.equal(crossCustomerHistory.status, 400);

    const unauthenticated = await fetch(`${baseUrl}/api/loyalty/balance`);
    assert.equal(unauthenticated.status, 401);

    const invalidRedeem = await send(
      "/api/loyalty/redeem",
      "customer",
      ids.customerId,
      "POST",
      { points: 0 }
    );
    assert.equal(invalidRedeem.status, 400);

    const overRedeem = await send(
      "/api/loyalty/redeem",
      "customer",
      ids.customerId,
      "POST",
      { points: 4 }
    );
    assert.equal(overRedeem.status, 409);

    const successfulRedeem = await send(
      "/api/loyalty/redeem",
      "customer",
      ids.customerId,
      "POST",
      { points: 1 }
    );
    assert.equal(successfulRedeem.status, 201);
    assert.equal((await successfulRedeem.json()).data.balance, 2);

    const concurrentRedeems = await Promise.all([
      send("/api/loyalty/redeem", "customer", ids.customerId, "POST", { points: 2 }),
      send("/api/loyalty/redeem", "customer", ids.customerId, "POST", { points: 2 }),
    ]);
    assert.deepEqual(
      concurrentRedeems.map((response) => response.status).sort(),
      [201, 409]
    );

    const finalBalance = await pool.query(
      `SELECT COALESCE(SUM(points), 0)::integer AS balance
       FROM loyalty_points
       WHERE user_id = $1`,
      [ids.customerId]
    );
    assert.equal(finalBalance.rows[0].balance, 0);
  } finally {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    if (cleanupNeeded) {
      const cleanup = await pool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query(
          "DELETE FROM loyalty_points WHERE user_id = ANY($1::uuid[])",
          [ids.userIds]
        );
        if (ids.bookingIds.length > 0) {
          await cleanup.query(
            "DELETE FROM queues WHERE booking_id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
          await cleanup.query(
            "DELETE FROM bookings WHERE id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
        }
        if (ids.barberId) {
          await cleanup.query("DELETE FROM barbers WHERE id = $1", [ids.barberId]);
        }
        if (ids.userIds.length > 0) {
          await cleanup.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids.userIds]);
        }
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        cleanup.release();
      }
    }

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
  }
});
