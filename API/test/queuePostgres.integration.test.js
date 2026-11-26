const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

require("dotenv").config();
const previousJwtSecret = process.env.JWT_SECRET;
const integrationJwtSecret = crypto.randomBytes(32).toString("hex");
process.env.JWT_SECRET = integrationJwtSecret;
const app = require("../src/app");
const pool = require("../src/config/database");
const verifyPostgresTestDatabase = require("./helpers/verifyPostgresTestDatabase");
const {
  createQueueForConfirmedBooking,
} = require("../src/controllers/queueController");

const runIntegration = process.env.RUN_POSTGRES_INTEGRATION === "1";

after(() => {
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("PostgreSQL queue integration: concurrency, uniqueness, rollback, and QR reuse", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_INTEGRATION=1 to run direct PostgreSQL integration tests"
    : false,
}, async () => {
  await verifyPostgresTestDatabase(pool);

  const suffix = crypto.randomUUID();
  const ids = {};
  let cleanupNeeded = false;

  const insertOne = async (client, sql, params) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  };

  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");

      const customer = await insertOne(
        setup,
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role, is_active
         )
         VALUES ($1, $2, $3, 'integration-test-only', 'customer', TRUE)
         RETURNING id`,
        [`Queue Customer ${suffix}`, `queue-${suffix}@example.invalid`, `900${Date.now().toString().slice(-10)}`]
      );
      ids.customerId = customer.id;

      const barberUser = await insertOne(
        setup,
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role, is_active
         )
         VALUES ($1, $2, $3, 'integration-test-only', 'barber', TRUE)
         RETURNING id`,
        [`Queue Barber ${suffix}`, `barber-${suffix}@example.invalid`, `800${Date.now().toString().slice(-10)}`]
      );
      ids.barberUserId = barberUser.id;

      const barber = await insertOne(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary queue integration test', TRUE)
         RETURNING id`,
        [barberUser.id]
      );
      ids.barberId = barber.id;

      const service = await insertOne(
        setup,
        `INSERT INTO services (
           service_name, description, price, duration_minutes, is_active
         )
         VALUES ($1, 'temporary queue integration test', 25000, 30, TRUE)
         RETURNING id`,
        [`Queue Service ${suffix}`]
      );
      ids.serviceId = service.id;

      const queueDate = new Date();
      queueDate.setDate(queueDate.getDate() + 2);
      const startAt = new Date(queueDate);
      startAt.setUTCHours(10, 0, 0, 0);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);

      const bookings = [];
      for (let index = 0; index < 2; index += 1) {
        const bookingCode = `CK-TEMP-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const booking = await insertOne(
          setup,
          `INSERT INTO bookings (
             customer_id, barber_id, booking_code, start_at, end_at,
             status, total_price, notes
           )
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
                   'confirmed', 25000, 'temporary queue integration test')
           RETURNING id`,
          [customer.id, barber.id, bookingCode, startAt.toISOString(), endAt.toISOString()]
        );
        bookings.push(booking);
        await setup.query(
          `INSERT INTO booking_items (
             booking_id, service_id, service_name, quantity, unit_price, duration_minutes
           )
           VALUES ($1, $2, $3, 1, 25000, 30)`,
          [booking.id, service.id, "Temporary Queue Service"]
        );
      }

      ids.bookingIds = bookings.map((booking) => booking.id);
      await setup.query("COMMIT");
      cleanupNeeded = true;
    } catch (error) {
      await setup.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      setup.release();
    }

    const [clientA, clientB] = await Promise.all([
      pool.connect(),
      pool.connect(),
    ]);
    let concurrentError = null;
    try {
      const createInTransaction = async (client, bookingId) => {
        await client.query("BEGIN");
        try {
          const queue = await createQueueForConfirmedBooking(client, bookingId);
          await client.query("COMMIT");
          return queue;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      };

      const queues = await Promise.all([
        createInTransaction(clientA, ids.bookingIds[0]),
        createInTransaction(clientB, ids.bookingIds[1]),
      ]);
      ids.queueIds = queues.map((queue) => queue.id);
    } catch (error) {
      concurrentError = error;
    } finally {
      clientA.release();
      clientB.release();
    }
    assert.equal(concurrentError, null);

    const result = await pool.query(
      `SELECT id, booking_id, queue_number, qr_token, status, queue_date
       FROM queues
       WHERE booking_id = ANY($1::uuid[])
       ORDER BY queue_number`,
      [ids.bookingIds]
    );
    assert.equal(result.rows.length, 2);
    assert.equal(new Set(result.rows.map((row) => row.queue_number)).size, 2);
    assert.equal(
      new Set(result.rows.map((row) => row.booking_id)).size,
      2
    );

    const duplicateCheck = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM queues
       WHERE barber_id = $1
         AND queue_date = $2::date`,
      [ids.barberId, result.rows[0].queue_date]
    );
    assert.equal(duplicateCheck.rows[0].count >= 2, true);

    const qrCheck = await pool.query(
      `UPDATE queues
       SET checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP)
       WHERE qr_token = $1
         AND checked_in_at IS NULL
       RETURNING id`,
      [result.rows[0].qr_token]
    );
    assert.equal(qrCheck.rows.length, 1);

    const qrReuse = await pool.query(
      `UPDATE queues
       SET checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP)
       WHERE qr_token = $1
         AND checked_in_at IS NULL
       RETURNING id`,
      [result.rows[0].qr_token]
    );
    assert.equal(qrReuse.rows.length, 0);

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query(
        `INSERT INTO queues (
           booking_id, barber_id, queue_date, queue_number, status
         )
         VALUES ($1, $2, CURRENT_DATE, 1, 'waiting')`,
        [ids.bookingIds[0], ids.barberId]
      );
      await rollbackClient.query("ROLLBACK");
    } catch (error) {
      await rollbackClient.query("ROLLBACK").catch(() => {});
    } finally {
      rollbackClient.release();
    }

    const rollbackCount = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM queues
       WHERE booking_id = $1`,
      [ids.bookingIds[0]]
    );
    assert.equal(rollbackCount.rows[0].count, 1);
  } finally {
    if (cleanupNeeded) {
      const cleanup = await pool.connect();
      try {
        await cleanup.query("BEGIN");
        if (ids.bookingIds) {
          await cleanup.query(
            "DELETE FROM queues WHERE booking_id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
          await cleanup.query(
            "DELETE FROM booking_items WHERE booking_id = ANY($1::uuid[])",
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
        if (ids.serviceId) {
          await cleanup.query("DELETE FROM services WHERE id = $1", [ids.serviceId]);
        }
        if (ids.barberUserId) {
          await cleanup.query("DELETE FROM users WHERE id = $1", [ids.barberUserId]);
        }
        if (ids.customerId) {
          await cleanup.query("DELETE FROM users WHERE id = $1", [ids.customerId]);
        }
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        cleanup.release();
      }
    }
  }
});

test("PostgreSQL serving concurrency: both start endpoints enforce per-barber locking", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_INTEGRATION=1 to run direct PostgreSQL integration tests"
    : false,
}, async () => {
  await verifyPostgresTestDatabase(pool);

  const suffix = crypto.randomUUID();
  const ids = {
    userIds: [],
    barberIds: [],
    bookingIds: [],
    queueIds: [],
  };
  let cleanupNeeded = false;
  let server;
  let baseUrl;

  const insertOne = async (client, sql, params) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  };

  const addUser = async (client, role, label) => {
    const user = await insertOne(
      client,
      `INSERT INTO users (
         full_name, email, phone_number, password_hash, role, is_active
       )
       VALUES ($1, $2, $3, 'integration-test-only', $4, TRUE)
       RETURNING id`,
      [
        `Serving ${label} ${suffix}`,
        `serving-${label}-${suffix}@example.invalid`,
        crypto.randomBytes(10).toString("hex"),
        role,
      ]
    );
    ids.userIds.push(user.id);
    return user.id;
  };

  const waitForBlockers = async (blockerPid, expectedCount) => {
    const deadline = Date.now() + 10_000;
    let observedCount = 0;
    let directBlockerCount = 0;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT COUNT(*) FILTER (
                 WHERE state = 'active'
                   AND wait_event_type = 'Lock'
                   AND query ILIKE '%FROM barbers%'
                   AND query ILIKE '%FOR UPDATE%'
               )::integer AS waiter_count,
               COUNT(*) FILTER (
                 WHERE $1::integer = ANY(pg_blocking_pids(pid))
               )::integer AS direct_blocker_count
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND usename = current_user
           AND pid <> pg_backend_pid()`,
        [blockerPid]
      );
      observedCount = result.rows[0].waiter_count;
      directBlockerCount = result.rows[0].direct_blocker_count;
      if (observedCount >= expectedCount) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const activity = await pool.query(
      `SELECT state, wait_event_type, COUNT(*)::integer AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND usename = current_user
         AND pid <> pg_backend_pid()
       GROUP BY state, wait_event_type`
    );
    throw new Error(
      `Timed out waiting for ${expectedCount} request(s) on the barber lock; ` +
      `observed ${observedCount} waiter(s), ${directBlockerCount} direct ` +
      `blocker(s), sessions ${JSON.stringify(activity.rows)}`
    );
  };

  const holdBarberLock = async (barberId) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockResult = await client.query(
        "SELECT id FROM barbers WHERE id = $1 FOR UPDATE",
        [barberId]
      );
      if (lockResult.rows.length !== 1) {
        throw new Error("Test fixture barber row was not found");
      }
      const result = await client.query("SELECT pg_backend_pid() AS pid");
      return { client, pid: result.rows[0].pid };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw error;
    }
  };

  const withTimeout = async (promise, label) => {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}`)),
            10_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  const assertServingState = async (barberId, expectedCount) => {
    const queueResult = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM queues
       WHERE barber_id = $1 AND status = 'serving'`,
      [barberId]
    );
    const bookingResult = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM bookings
       WHERE barber_id = $1 AND status = 'in_progress'`,
      [barberId]
    );
    assert.equal(queueResult.rows[0].count, expectedCount);
    assert.equal(bookingResult.rows[0].count, expectedCount);
  };

  const runSameBarberRequests = async (barberId, requestFactories) => {
    const holder = await holdBarberLock(barberId);
    let released = false;
    const requests = requestFactories.map((request) => request());
    const outcomes = requests.map(() => "pending");
    requests.forEach((request, index) => {
      request.then(
        (response) => {
          outcomes[index] = `HTTP ${response.status}`;
        },
        (error) => {
          outcomes[index] = `ERROR ${error.message}`;
        }
      );
    });
    try {
      try {
        await waitForBlockers(holder.pid, requests.length);
      } catch (error) {
        throw new Error(`${error.message}; requests ${JSON.stringify(outcomes)}`);
      }
      await holder.client.query("COMMIT");
      released = true;
      const responses = await Promise.all(requests);
      assert.deepEqual(
        responses.map((response) => response.status).sort((a, b) => a - b),
        [200, 409]
      );
    } finally {
      if (!released) await holder.client.query("ROLLBACK");
      holder.client.release();
      await Promise.allSettled(requests);
    }
  };

  const runDifferentBarberRequests = async (
    lockedBarberId,
    blockedRequest,
    independentRequest
  ) => {
    const holder = await holdBarberLock(lockedBarberId);
    let released = false;
    let blockedCompleted = false;
    const blocked = blockedRequest().finally(() => {
      blockedCompleted = true;
    });
    const independent = independentRequest();
    try {
      await waitForBlockers(holder.pid, 1);
      const independentResponse = await withTimeout(
        independent,
        "request for the other barber"
      );
      assert.equal(independentResponse.status, 200);
      assert.equal(blockedCompleted, false);

      await holder.client.query("COMMIT");
      released = true;
      const blockedResponse = await withTimeout(
        blocked,
        "request for the locked barber"
      );
      assert.equal(blockedResponse.status, 200);
    } finally {
      if (!released) await holder.client.query("ROLLBACK");
      holder.client.release();
      await Promise.allSettled([blocked, independent]);
    }
  };

  try {
    const setup = await pool.connect();
    const fixtures = {};
    try {
      await setup.query("BEGIN");
      const service = await insertOne(
        setup,
        `INSERT INTO services (
           service_name, description, price, duration_minutes, is_active
         )
         VALUES ($1, 'temporary serving concurrency test', 25000, 30, TRUE)
         RETURNING id`,
        [`Serving Service ${suffix}`]
      );
      ids.serviceId = service.id;

      const addBarber = async (label) => {
        const userId = await addUser(setup, "barber", `${label}-barber`);
        const barber = await insertOne(
          setup,
          `INSERT INTO barbers (user_id, bio, is_available)
           VALUES ($1, 'temporary serving concurrency test', TRUE)
           RETURNING id`,
          [userId]
        );
        ids.barberIds.push(barber.id);
        return { id: barber.id, userId };
      };

      const addBookingQueue = async (barber, label, queueNumber) => {
        const customerId = await addUser(
          setup,
          "customer",
          `${label}-customer`
        );
        const startAt = new Date(Date.now() - 5 * 60_000);
        const endAt = new Date(startAt.getTime() + 30 * 60_000);
        const bookingCode =
          `P0-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const booking = await insertOne(
          setup,
          `INSERT INTO bookings (
             customer_id, barber_id, booking_code, start_at, end_at,
             status, total_price, notes
           )
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
                   'confirmed', 25000, 'temporary serving concurrency test')
           RETURNING id`,
          [
            customerId,
            barber.id,
            bookingCode,
            startAt.toISOString(),
            endAt.toISOString(),
          ]
        );
        ids.bookingIds.push(booking.id);
        await setup.query(
          `INSERT INTO booking_items (
             booking_id, service_id, service_name, quantity,
             unit_price, duration_minutes
           )
           VALUES ($1, $2, 'Temporary Serving Service', 1, 25000, 30)`,
          [booking.id, ids.serviceId]
        );
        const queue = await insertOne(
          setup,
          `INSERT INTO queues (
             booking_id, barber_id, queue_date, queue_number, status
           )
           VALUES ($1, $2, CURRENT_DATE, $3, 'called')
           RETURNING id`,
          [booking.id, barber.id, queueNumber]
        );
        ids.queueIds.push(queue.id);
        return {
          barberId: barber.id,
          barberUserId: barber.userId,
          bookingId: booking.id,
          queueId: queue.id,
        };
      };

      const queueSameBarber = await addBarber("queue-same");
      fixtures.queueSame = [
        await addBookingQueue(queueSameBarber, "queue-same-one", 1),
        await addBookingQueue(queueSameBarber, "queue-same-two", 2),
      ];

      const queueDifferentA = await addBarber("queue-different-a");
      const queueDifferentB = await addBarber("queue-different-b");
      fixtures.queueDifferent = [
        await addBookingQueue(queueDifferentA, "queue-different-one", 1),
        await addBookingQueue(queueDifferentB, "queue-different-two", 1),
      ];

      const bookingSameBarber = await addBarber("booking-same");
      fixtures.bookingSame = [
        await addBookingQueue(bookingSameBarber, "booking-same-one", 1),
        await addBookingQueue(bookingSameBarber, "booking-same-two", 2),
      ];

      const bookingDifferentA = await addBarber("booking-different-a");
      const bookingDifferentB = await addBarber("booking-different-b");
      fixtures.bookingDifferent = [
        await addBookingQueue(bookingDifferentA, "booking-different-one", 1),
        await addBookingQueue(bookingDifferentB, "booking-different-two", 1),
      ];

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

    const tokenFor = (barberUserId) =>
      jwt.sign({ id: barberUserId, role: "barber" }, integrationJwtSecret);
    const startQueue = (fixture) => () =>
      fetch(`${baseUrl}/api/queues/${fixture.queueId}/start`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${tokenFor(fixture.barberUserId)}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
    const startBooking = (fixture) => () =>
      fetch(`${baseUrl}/api/bookings/${fixture.bookingId}/status`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${tokenFor(fixture.barberUserId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
        signal: AbortSignal.timeout(15_000),
      });

    await runSameBarberRequests(
      fixtures.queueSame[0].barberId,
      fixtures.queueSame.map(startQueue)
    );
    await assertServingState(fixtures.queueSame[0].barberId, 1);

    await runDifferentBarberRequests(
      fixtures.queueDifferent[0].barberId,
      startQueue(fixtures.queueDifferent[0]),
      startQueue(fixtures.queueDifferent[1])
    );
    await assertServingState(fixtures.queueDifferent[0].barberId, 1);
    await assertServingState(fixtures.queueDifferent[1].barberId, 1);

    await runSameBarberRequests(
      fixtures.bookingSame[0].barberId,
      fixtures.bookingSame.map(startBooking)
    );
    await assertServingState(fixtures.bookingSame[0].barberId, 1);

    await runDifferentBarberRequests(
      fixtures.bookingDifferent[0].barberId,
      startBooking(fixtures.bookingDifferent[0]),
      startBooking(fixtures.bookingDifferent[1])
    );
    await assertServingState(fixtures.bookingDifferent[0].barberId, 1);
    await assertServingState(fixtures.bookingDifferent[1].barberId, 1);
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
        if (ids.queueIds.length > 0) {
          await cleanup.query(
            "DELETE FROM queues WHERE id = ANY($1::uuid[])",
            [ids.queueIds]
          );
        }
        if (ids.bookingIds.length > 0) {
          await cleanup.query(
            "DELETE FROM booking_items WHERE booking_id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
          await cleanup.query(
            "DELETE FROM bookings WHERE id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
        }
        if (ids.barberIds.length > 0) {
          await cleanup.query(
            "DELETE FROM barbers WHERE id = ANY($1::uuid[])",
            [ids.barberIds]
          );
        }
        if (ids.serviceId) {
          await cleanup.query("DELETE FROM services WHERE id = $1", [ids.serviceId]);
        }
        if (ids.userIds.length > 0) {
          await cleanup.query(
            "DELETE FROM users WHERE id = ANY($1::uuid[])",
            [ids.userIds]
          );
        }
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        cleanup.release();
      }
    }
  }
});
