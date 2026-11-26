const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const integrationJwtSecret = crypto.randomBytes(32).toString("hex");
const previousJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = integrationJwtSecret;

const app = require("../src/app");
const pool = require("../src/config/database");
const verifyPostgresTestDatabase = require("./helpers/verifyPostgresTestDatabase");
const runIntegration =
  process.env.RUN_POSTGRES_VOUCHER_INTEGRATION === "1";
const createToken = (role, id) =>
  jwt.sign({ id, role }, integrationJwtSecret);

const futureStartAt = (daysAhead) => {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60_000);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3)
  ).toISOString();
};

const createTest = async (client, statement, params) => {
  const result = await client.query(statement, params);
  return result.rows[0];
};

test("PostgreSQL voucher integration: net booking total, quota, cancellation, no-show, and concurrency", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_VOUCHER_INTEGRATION=1 to run PostgreSQL voucher integration tests"
    : false,
}, async () => {
  await verifyPostgresTestDatabase(pool);

  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
  const ids = {
    userIds: [],
    barberIds: [],
    bookingIds: [],
    voucherIds: [],
    serviceIds: [],
    scheduleIds: [],
  };
  let cleanupNeeded = false;
  let server;
  let baseUrl;
  const createdCodes = {
    main: `V-${suffix}-MAIN`,
    noShow: `V-${suffix}-NOSHOW`,
    adminCancel: `V-${suffix}-CANCEL`,
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

  const createBooking = async (
    code,
    daysAhead,
    barberId = ids.barberId
  ) =>
    send("/api/bookings", "customer", ids.customerId, "POST", {
      barber_id: barberId,
      start_at: futureStartAt(daysAhead),
      items: [{ service_id: ids.serviceId, quantity: 1 }],
      voucher_code: code,
    });

  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");

      const customer = await createTest(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'customer')
         RETURNING id`,
        [
          `Voucher Customer ${suffix}`,
          `voucher-${suffix}@example.invalid`,
          `9${crypto.randomBytes(8).toString("hex")}`,
        ]
      );
      ids.customerId = customer.id;
      ids.userIds.push(customer.id);

      const barberUser = await createTest(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'barber')
         RETURNING id`,
        [
          `Voucher Barber ${suffix}`,
          `voucher-barber-${suffix}@example.invalid`,
          `8${crypto.randomBytes(8).toString("hex")}`,
        ]
      );
      ids.userIds.push(barberUser.id);

      const barber = await createTest(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary voucher integration test', TRUE)
         RETURNING id`,
        [barberUser.id]
      );
      ids.barberId = barber.id;
      ids.barberIds.push(barber.id);
      ids.barberUserId = barberUser.id;

      const secondBarberUser = await createTest(
        setup,
        `INSERT INTO users (full_name, email, phone_number, password_hash, role)
         VALUES ($1, $2, $3, 'integration-test-only', 'barber')
         RETURNING id`,
        [
          `Voucher Barber Two ${suffix}`,
          `voucher-barber-two-${suffix}@example.invalid`,
          `7${crypto.randomBytes(8).toString("hex")}`,
        ]
      );
      ids.userIds.push(secondBarberUser.id);
      const secondBarber = await createTest(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary voucher integration test', TRUE)
         RETURNING id`,
        [secondBarberUser.id]
      );
      ids.secondaryBarberId = secondBarber.id;
      ids.barberIds.push(secondBarber.id);

      const service = await createTest(
        setup,
        `INSERT INTO services (service_name, description, price, duration_minutes)
         VALUES ($1, 'temporary voucher integration test', 25000.00, 30)
         RETURNING id`,
        [`Voucher Haircut ${suffix}`]
      );
      ids.serviceId = service.id;
      ids.serviceIds.push(service.id);

      for (const scheduledBarberId of ids.barberIds) {
        for (let day = 0; day < 7; day += 1) {
          const schedule = await createTest(
            setup,
            `INSERT INTO schedules (barber_id, day_of_week, start_time, end_time)
             VALUES ($1, $2, '00:00', '23:59')
             RETURNING id`,
            [scheduledBarberId, day]
          );
          ids.scheduleIds.push(schedule.id);
        }
      }

      for (const [code, usageLimit, discountType, discountValue, maxDiscount] of [
        [createdCodes.main, 1, "percentage", 10, 1000],
        [createdCodes.noShow, 10, "fixed", 1000, null],
        [createdCodes.adminCancel, 10, "fixed", 1000, null],
      ]) {
        const voucher = await createTest(
          setup,
          `INSERT INTO vouchers (
             code, discount_type, discount_value, minimum_transaction,
             max_discount, usage_limit, start_at, end_at, is_active
           )
           VALUES ($1, $2, $3, 0, $4, $5, CURRENT_TIMESTAMP - INTERVAL '1 day',
                   CURRENT_TIMESTAMP + INTERVAL '7 days', TRUE)
           RETURNING id`,
          [code, discountType, discountValue, maxDiscount, usageLimit]
        );
        ids.voucherIds.push(voucher.id);
      }

      const noShowVoucherId = (
        await setup.query("SELECT id FROM vouchers WHERE code = $1", [
          createdCodes.noShow,
        ])
      ).rows[0].id;
      await setup.query(
        "UPDATE vouchers SET used_count = 1 WHERE id = $1",
        [noShowVoucherId]
      );
      const noShowStart = new Date(Date.now() - 60 * 60_000);
      const noShowBooking = await createTest(
        setup,
        `INSERT INTO bookings (
           customer_id, barber_id, booking_code, start_at, end_at,
           status, total_price, voucher_id
         )
         VALUES ($1, $2, $3, $4, $5, 'confirmed', 24000, $6)
         RETURNING id`,
        [
          customer.id,
          barber.id,
          `VOUCHER-${suffix}-NOSHOW`,
          noShowStart.toISOString(),
          new Date(noShowStart.getTime() + 30 * 60_000).toISOString(),
          noShowVoucherId,
        ]
      );
      ids.noShowBookingId = noShowBooking.id;
      ids.bookingIds.push(noShowBooking.id);

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

    const preview = await send(
      "/api/vouchers/validate",
      "customer",
      ids.customerId,
      "POST",
      {
        code: ` ${createdCodes.main.toLowerCase()} `,
        items: [{ service_id: ids.serviceId }],
      }
    );
    const previewBody = await preview.json();
    assert.equal(preview.status, 200, previewBody.message);
    assert.equal(previewBody.data.total_price, "24000.00");

    const firstBooking = await createBooking(createdCodes.main, 2);
    assert.equal(firstBooking.status, 201);
    const firstBookingData = (await firstBooking.json()).data;
    assert.equal(firstBookingData.total_price, "24000.00");
    assert.equal(firstBookingData.voucher_code, createdCodes.main);
    ids.bookingIds.push(firstBookingData.id);

    const firstCount = await pool.query(
      "SELECT used_count FROM vouchers WHERE code = $1",
      [createdCodes.main]
    );
    assert.equal(firstCount.rows[0].used_count, 1);

    const cancelled = await send(
      `/api/bookings/${firstBookingData.id}/cancel`,
      "customer",
      ids.customerId,
      "PATCH"
    );
    assert.equal(cancelled.status, 200);
    const duplicateCancel = await send(
      `/api/bookings/${firstBookingData.id}/cancel`,
      "customer",
      ids.customerId,
      "PATCH"
    );
    assert.equal(duplicateCancel.status, 409);

    const afterCancel = await pool.query(
      "SELECT used_count FROM vouchers WHERE code = $1",
      [createdCodes.main]
    );
    assert.equal(afterCancel.rows[0].used_count, 0);

    const competingBookings = await Promise.all([
      createBooking(createdCodes.main, 3, ids.barberId),
      createBooking(createdCodes.main, 3, ids.secondaryBarberId),
    ]);
    assert.deepEqual(
      competingBookings.map((response) => response.status).sort(),
      [201, 409]
    );
    const successfulResponse = competingBookings.find(
      (response) => response.status === 201
    );
    const successfulBooking = (await successfulResponse.json()).data;
    ids.bookingIds.push(successfulBooking.id);
    assert.equal(successfulBooking.total_price, "24000.00");

    const counterAfterRace = await pool.query(
      "SELECT used_count FROM vouchers WHERE code = $1",
      [createdCodes.main]
    );
    assert.equal(counterAfterRace.rows[0].used_count, 1);

    await pool.query(
      "UPDATE bookings SET status = 'in_progress' WHERE id = $1",
      [successfulBooking.id]
    );
    const completed = await send(
      `/api/bookings/${successfulBooking.id}/status`,
      "admin",
      ids.customerId,
      "PATCH",
      { status: "completed" }
    );
    assert.equal(completed.status, 200);
    const earned = await pool.query(
      `SELECT points FROM loyalty_points
       WHERE booking_id = $1 AND transaction_type = 'earn'`,
      [successfulBooking.id]
    );
    assert.equal(earned.rows[0].points, 2);

    const noShow = await send(
      `/api/bookings/${ids.noShowBookingId}/status`,
      "admin",
      ids.customerId,
      "PATCH",
      { status: "no_show" }
    );
    assert.equal(noShow.status, 200);
    const noShowCount = await pool.query(
      "SELECT used_count FROM vouchers WHERE code = $1",
      [createdCodes.noShow]
    );
    assert.equal(noShowCount.rows[0].used_count, 1);

    const adminCancelBooking = await createBooking(createdCodes.adminCancel, 5);
    assert.equal(adminCancelBooking.status, 201);
    const adminCancelData = (await adminCancelBooking.json()).data;
    ids.bookingIds.push(adminCancelData.id);
    const adminCancelled = await send(
      `/api/bookings/${adminCancelData.id}/status`,
      "admin",
      ids.customerId,
      "PATCH",
      { status: "cancelled" }
    );
    assert.equal(adminCancelled.status, 200);
    const adminCancelCount = await pool.query(
      "SELECT used_count FROM vouchers WHERE code = $1",
      [createdCodes.adminCancel]
    );
    assert.equal(adminCancelCount.rows[0].used_count, 0);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (cleanupNeeded) {
      const cleanup = await pool.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query(
          "DELETE FROM loyalty_points WHERE booking_id = ANY($1::uuid[])",
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
        await cleanup.query(
          "DELETE FROM vouchers WHERE id = ANY($1::uuid[])",
          [ids.voucherIds]
        );
        await cleanup.query(
          "DELETE FROM schedules WHERE id = ANY($1::uuid[])",
          [ids.scheduleIds]
        );
        await cleanup.query(
          "DELETE FROM services WHERE id = ANY($1::uuid[])",
          [ids.serviceIds]
        );
        await cleanup.query(
          "DELETE FROM barbers WHERE id = ANY($1::uuid[])",
          [ids.barberIds]
        );
        await cleanup.query(
          "DELETE FROM users WHERE id = ANY($1::uuid[])",
          [ids.userIds]
        );
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
  }
});
