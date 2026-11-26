const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const integrationJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = integrationJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");
const verifyPostgresTestDatabase = require("./helpers/verifyPostgresTestDatabase");
const { notifyBookingConfirmed, notifyQueueStatus } = require(
  "../src/services/notificationService"
);

const runIntegration = process.env.RUN_POSTGRES_NOTIFICATION_INTEGRATION === "1";
const createToken = (role, id) =>
  jwt.sign({ id, role }, integrationJwtSecret);

after(() => {
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("PostgreSQL notifications: ownership, booking and queue events, deduplication, and rollback", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_NOTIFICATION_INTEGRATION=1 to run PostgreSQL notification integration tests"
    : false,
}, async () => {
  await verifyPostgresTestDatabase(pool);

  const suffix = crypto.randomUUID();
  const ids = { userIds: [], bookingIds: [], scheduleIds: [] };
  let cleanupNeeded = false;
  let server;
  let baseUrl;

  const insertOne = async (client, sql, params) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  };

  const addUser = async (client, role, label, isActive = true) => {
    const row = await insertOne(
      client,
      `INSERT INTO users (
         full_name, email, phone_number, password_hash, role, is_active
       )
       VALUES ($1, $2, $3, 'integration-test-only', $4, $5)
       RETURNING id`,
      [
        `Notification ${label} ${suffix}`,
        `notification-${label}-${suffix}@example.invalid`,
        `${crypto.randomBytes(8).toString("hex")}`.slice(0, 20),
        role,
        isActive,
      ]
    );
    ids.userIds.push(row.id);
    return row.id;
  };

  const addBooking = async (client, customerId, barberId, daysAhead, minute) => {
    const startAt = new Date();
    startAt.setUTCDate(startAt.getUTCDate() + daysAhead);
    startAt.setUTCHours(3, minute, 0, 0);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    const bookingCode = `NTF-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const row = await insertOne(
      client,
      `INSERT INTO bookings (
         customer_id, barber_id, booking_code, start_at, end_at, status, total_price
       )
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'pending', 25000)
       RETURNING id`,
      [customerId, barberId, bookingCode, startAt.toISOString(), endAt.toISOString()]
    );
    ids.bookingIds.push(row.id);
    return { id: row.id, bookingCode, startAt };
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

  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      ids.customerId = await addUser(setup, "customer", "customer");
      ids.otherCustomerId = await addUser(setup, "customer", "other");
      ids.barberUserId = await addUser(setup, "barber", "barber");
      ids.adminId = await addUser(setup, "admin", "admin");
      ids.inactiveAdminId = await addUser(
        setup,
        "admin",
        "inactive-admin",
        false
      );
      const activeAdmins = await setup.query(
        "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE"
      );
      ids.activeAdminIds = activeAdmins.rows.map((row) => row.id);

      const barber = await insertOne(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary notification integration test', TRUE)
         RETURNING id`,
        [ids.barberUserId]
      );
      ids.barberId = barber.id;

      const service = await insertOne(
        setup,
        `INSERT INTO services (
           service_name, description, price, duration_minutes, is_active
         )
         VALUES ($1, 'temporary notification integration test', 25000, 30, TRUE)
         RETURNING id`,
        [`Notification Service ${suffix}`]
      );
      ids.serviceId = service.id;

      const schedules = await setup.query(
        `INSERT INTO schedules (
           barber_id, day_of_week, start_time, end_time, is_available
         )
         SELECT $1, day_number, '00:00', '23:59:59', TRUE
         FROM generate_series(0, 6) AS day_number
         RETURNING id`,
        [ids.barberId]
      );
      ids.scheduleIds = schedules.rows.map((row) => row.id);

      const rollbackBooking = await addBooking(
        setup,
        ids.customerId,
        ids.barberId,
        8,
        0
      );
      ids.rollbackBookingId = rollbackBooking.id;

      const rollbackQueueBooking = await addBooking(
        setup,
        ids.customerId,
        ids.barberId,
        9,
        0
      );
      ids.rollbackQueueBookingId = rollbackQueueBooking.id;
      const rollbackQueue = await insertOne(
        setup,
        `INSERT INTO queues (
           booking_id, barber_id, queue_date, queue_number, status
         )
         VALUES ($1, $2, CURRENT_DATE + 9, 900, 'waiting')
         RETURNING id`,
        [rollbackQueueBooking.id, ids.barberId]
      );
      ids.rollbackQueueId = rollbackQueue.id;

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

    const requestBody = (daysAhead, minute) => {
      const startAt = new Date();
      startAt.setUTCDate(startAt.getUTCDate() + daysAhead);
      startAt.setUTCHours(3, minute, 0, 0);
      return {
        barber_id: ids.barberId,
        start_at: startAt.toISOString(),
        items: [{ service_id: ids.serviceId, quantity: 1 }],
      };
    };

    const createBooking = async (daysAhead, minute) => {
      const response = await send(
        "/api/bookings",
        "customer",
        ids.customerId,
        "POST",
        requestBody(daysAhead, minute)
      );
      const body = await response.json();
      assert.equal(response.status, 201, body.message);
      ids.bookingIds.push(body.data.id);
      return body.data;
    };

    const first = await createBooking(2, 0);
    const barberNotifications = await pool.query(
      `SELECT user_id, title, message, notification_type
       FROM notifications
       WHERE message LIKE $1
       ORDER BY user_id`,
      [`%${first.booking_code}%`]
    );
    assert.equal(barberNotifications.rows.length, 1 + ids.activeAdminIds.length);
    assert.deepEqual(
      barberNotifications.rows.map((row) => row.user_id).sort(),
      [ids.barberUserId, ...ids.activeAdminIds].sort()
    );
    assert.equal(
      barberNotifications.rows.some(
        (row) => row.user_id === ids.inactiveAdminId
      ),
      false
    );

    const otherInbox = await send("/api/notifications", "customer", ids.otherCustomerId);
    assert.equal((await otherInbox.json()).data.notifications.length, 0);
    const ownInbox = await send("/api/notifications", "customer", ids.customerId);
    assert.equal((await ownInbox.json()).data.notifications.length, 0);

    const barberInbox = await send("/api/notifications", "barber", ids.barberUserId);
    assert.equal(
      (await barberInbox.json()).data.notifications.some((notification) =>
        notification.message.includes(first.booking_code)
      ),
      true
    );
    const adminInbox = await send("/api/notifications", "admin", ids.adminId);
    assert.equal(
      (await adminInbox.json()).data.notifications.some((notification) =>
        notification.message.includes(first.booking_code)
      ),
      true
    );

    const confirmed = await send(
      `/api/bookings/${first.id}/status`,
      "barber",
      ids.barberUserId,
      "PATCH",
      { status: "confirmed" }
    );
    assert.equal(confirmed.status, 200);
    const confirmationCount = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM notifications
       WHERE user_id = $1 AND title = 'Booking dikonfirmasi'
         AND message LIKE $2`,
      [ids.customerId, `%${first.booking_code}%`]
    );
    assert.equal(confirmationCount.rows[0].count, 1);
    const customerInbox = await send("/api/notifications", "customer", ids.customerId);
    const customerNotifications = (await customerInbox.json()).data.notifications;
    assert.equal(
      customerNotifications.some((notification) =>
        notification.message.includes(first.booking_code)
      ),
      true
    );
    const otherCustomerInbox = await send(
      "/api/notifications",
      "customer",
      ids.otherCustomerId
    );
    assert.equal(
      (await otherCustomerInbox.json()).data.notifications.length,
      0
    );

    const queueResult = await pool.query(
      "SELECT id FROM queues WHERE booking_id = $1",
      [first.id]
    );
    assert.equal(queueResult.rows.length, 1);
    const queueId = queueResult.rows[0].id;

    for (const [endpoint, title] of [
      ["call", "Antrean dipanggil"],
      ["start", "Antrean dimulai"],
      ["complete", "Antrean selesai"],
    ]) {
      const response = await send(
        `/api/queues/${queueId}/${endpoint}`,
        "barber",
        ids.barberUserId,
        "PATCH"
      );
      assert.equal(response.status, 200);

      const found = await pool.query(
        `SELECT COUNT(*)::integer AS count
         FROM notifications
         WHERE user_id = $1 AND title = $2 AND message LIKE $3`,
        [ids.customerId, title, `%${first.booking_code}%`]
      );
      assert.equal(found.rows[0].count, 1);
    }

    const second = await createBooking(3, 0);
    const customerCancel = await send(
      `/api/bookings/${second.id}/cancel`,
      "customer",
      ids.customerId,
      "PATCH"
    );
    assert.equal(customerCancel.status, 200);
    assert.equal(
      (await send(
        `/api/bookings/${second.id}/cancel`,
        "customer",
        ids.customerId,
        "PATCH"
      )).status,
      409
    );

    const third = await createBooking(4, 0);
    const adminCancel = await send(
      `/api/bookings/${third.id}/status`,
      "admin",
      ids.adminId,
      "PATCH",
      { status: "cancelled" }
    );
    assert.equal(adminCancel.status, 200);
    assert.equal(
      (await send(
        `/api/bookings/${third.id}/status`,
        "admin",
        ids.adminId,
        "PATCH",
        { status: "cancelled" }
      )).status,
      409
    );

    const fourth = await createBooking(5, 0);
    const fourthConfirmation = await send(
      `/api/bookings/${fourth.id}/status`,
      "barber",
      ids.barberUserId,
      "PATCH",
      { status: "confirmed" }
    );
    assert.equal(fourthConfirmation.status, 200);
    const fourthQueue = await pool.query(
      "SELECT id FROM queues WHERE booking_id = $1",
      [fourth.id]
    );
    const queueCancel = await send(
      `/api/queues/${fourthQueue.rows[0].id}/cancel`,
      "customer",
      ids.customerId,
      "PATCH"
    );
    assert.equal(queueCancel.status, 200);
    assert.equal(
      (await send(
        `/api/queues/${fourthQueue.rows[0].id}/cancel`,
        "customer",
        ids.customerId,
        "PATCH"
      )).status,
      409
    );

    for (const booking of [second, third, fourth]) {
      const cancellationRecipients = await pool.query(
        `SELECT user_id
         FROM notifications
         WHERE title = 'Booking dibatalkan'
           AND message LIKE $1
         ORDER BY user_id`,
        [`%${booking.booking_code}%`]
      );
      assert.deepEqual(
        cancellationRecipients.rows.map((row) => row.user_id).sort(),
        [ids.customerId, ids.barberUserId, ...ids.activeAdminIds].sort()
      );
    }

    const fifth = await createBooking(6, 0);
    const fifthConfirmation = await send(
      `/api/bookings/${fifth.id}/status`,
      "barber",
      ids.barberUserId,
      "PATCH",
      { status: "confirmed" }
    );
    assert.equal(fifthConfirmation.status, 200);
    const fifthQueue = await pool.query(
      "SELECT id FROM queues WHERE booking_id = $1",
      [fifth.id]
    );
    const bookingStarted = await send(
      `/api/bookings/${fifth.id}/status`,
      "barber",
      ids.barberUserId,
      "PATCH",
      { status: "in_progress" }
    );
    assert.equal(bookingStarted.status, 200);
    const queueStartNotification = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM notifications
       WHERE user_id = $1 AND title = 'Antrean dimulai'
         AND message LIKE $2`,
      [ids.customerId, `%${fifth.booking_code}%`]
    );
    assert.equal(queueStartNotification.rows[0].count, 1);
    assert.equal(
      (await send(
        `/api/queues/${fifthQueue.rows[0].id}/start`,
        "barber",
        ids.barberUserId,
        "PATCH"
      )).status,
      409
    );

    const bookingCompleted = await send(
      `/api/bookings/${fifth.id}/status`,
      "barber",
      ids.barberUserId,
      "PATCH",
      { status: "completed" }
    );
    assert.equal(bookingCompleted.status, 200);
    const queueCompleteNotification = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM notifications
       WHERE user_id = $1 AND title = 'Antrean selesai'
         AND message LIKE $2`,
      [ids.customerId, `%${fifth.booking_code}%`]
    );
    assert.equal(queueCompleteNotification.rows[0].count, 1);
    assert.equal(
      (await send(
        `/api/queues/${fifthQueue.rows[0].id}/complete`,
        "barber",
        ids.barberUserId,
        "PATCH"
      )).status,
      409
    );

    const foreignRead = await send(
      `/api/notifications/${(await pool.query(
        `SELECT id FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [ids.customerId]
      )).rows[0].id}/read`,
      "customer",
      ids.otherCustomerId,
      "PATCH"
    );
    assert.equal(foreignRead.status, 404);

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query(
        "UPDATE bookings SET status = 'confirmed' WHERE id = $1",
        [ids.rollbackBookingId]
      );
      await assert.rejects(
        notifyBookingConfirmed(rollbackClient, {
          customerId: crypto.randomUUID(),
          bookingCode: "rollback-booking-notification",
        }),
        (error) => error.code === "23503"
      );
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    const bookingRollbackState = await pool.query(
      "SELECT status FROM bookings WHERE id = $1",
      [ids.rollbackBookingId]
    );
    assert.equal(bookingRollbackState.rows[0].status, "pending");

    const queueRollbackClient = await pool.connect();
    try {
      await queueRollbackClient.query("BEGIN");
      await queueRollbackClient.query(
        "UPDATE queues SET status = 'called' WHERE id = $1",
        [ids.rollbackQueueId]
      );
      await assert.rejects(
        notifyQueueStatus(
          queueRollbackClient,
          {
            customerId: crypto.randomUUID(),
            bookingCode: "rollback-queue-notification",
            queueNumber: 900,
          },
          "called"
        ),
        (error) => error.code === "23503"
      );
      await queueRollbackClient.query("ROLLBACK");
    } finally {
      queueRollbackClient.release();
    }
    const queueRollbackState = await pool.query(
      "SELECT status FROM queues WHERE id = $1",
      [ids.rollbackQueueId]
    );
    assert.equal(queueRollbackState.rows[0].status, "waiting");
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
        if (ids.bookingIds.length > 0) {
          await cleanup.query(
            "DELETE FROM loyalty_points WHERE booking_id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
          await cleanup.query(
            "DELETE FROM bookings WHERE id = ANY($1::uuid[])",
            [ids.bookingIds]
          );
        }
        if (ids.barberId) {
          await cleanup.query("DELETE FROM schedules WHERE barber_id = $1", [ids.barberId]);
          await cleanup.query("DELETE FROM barbers WHERE id = $1", [ids.barberId]);
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
