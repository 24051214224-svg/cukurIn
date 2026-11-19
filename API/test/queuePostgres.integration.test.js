const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");

require("dotenv").config();
const pool = require("../src/config/database");
const {
  createQueueForConfirmedBooking,
} = require("../src/controllers/queueController");

const runIntegration = process.env.RUN_POSTGRES_INTEGRATION === "1";

test("PostgreSQL queue integration: concurrency, uniqueness, rollback, and QR reuse", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_INTEGRATION=1 to run direct PostgreSQL integration tests"
    : false,
}, async () => {
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
