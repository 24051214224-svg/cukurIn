const assert = require("node:assert/strict");
const { test } = require("node:test");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

require("dotenv").config();
const app = require("../src/app");
const pool = require("../src/config/database");

const runIntegration =
  process.env.RUN_POSTGRES_REVIEW_INTEGRATION === "1";

test("PostgreSQL review integration: ownership, status, uniqueness, and scoped reads", {
  skip: !runIntegration
    ? "Set RUN_POSTGRES_REVIEW_INTEGRATION=1 to run direct PostgreSQL review integration tests"
    : false,
}, async () => {
  const suffix = crypto.randomUUID();
  const ids = {};
  let cleanupNeeded = false;
  let server;
  let baseUrl;

  const insertOne = async (client, sql, params) => {
    const result = await client.query(sql, params);
    return result.rows[0];
  };

  const authHeaders = (role, id) => ({
    Authorization: `Bearer ${jwt.sign({ id, role }, process.env.JWT_SECRET)}`,
    "Content-Type": "application/json",
  });

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
        [
          `Review Customer ${suffix}`,
          `review-owner-${suffix}@example.invalid`,
          `711${crypto.randomBytes(8).toString("hex").slice(0, 14)}`,
        ]
      );
      ids.customerId = customer.id;

      const otherCustomer = await insertOne(
        setup,
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role, is_active
         )
         VALUES ($1, $2, $3, 'integration-test-only', 'customer', TRUE)
         RETURNING id`,
        [
          `Review Other Customer ${suffix}`,
          `review-other-${suffix}@example.invalid`,
          `712${crypto.randomBytes(8).toString("hex").slice(0, 14)}`,
        ]
      );
      ids.otherCustomerId = otherCustomer.id;

      const barberUser = await insertOne(
        setup,
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role, is_active
         )
         VALUES ($1, $2, $3, 'integration-test-only', 'barber', TRUE)
         RETURNING id`,
        [
          `Review Barber ${suffix}`,
          `review-barber-${suffix}@example.invalid`,
          `713${crypto.randomBytes(8).toString("hex").slice(0, 14)}`,
        ]
      );
      ids.barberUserId = barberUser.id;

      const barber = await insertOne(
        setup,
        `INSERT INTO barbers (user_id, bio, is_available)
         VALUES ($1, 'temporary review integration test', TRUE)
         RETURNING id`,
        [barberUser.id]
      );
      ids.barberId = barber.id;

      const startAt = new Date();
      startAt.setUTCDate(startAt.getUTCDate() - 2);
      startAt.setUTCHours(10, 0, 0, 0);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);

      const insertBooking = async (customerId, status, label) => {
        const bookingCode =
          `CK-REV-${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
        return insertOne(
          setup,
          `INSERT INTO bookings (
             customer_id, barber_id, booking_code, start_at, end_at,
             status, total_price, notes
           )
           VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
                   $6, 25000, $7)
           RETURNING id`,
          [
            customerId,
            barber.id,
            bookingCode,
            startAt.toISOString(),
            endAt.toISOString(),
            status,
            label,
          ]
        );
      };

      const completedBooking = await insertBooking(
        customer.id,
        "completed",
        "temporary review completed fixture"
      );
      const pendingBooking = await insertBooking(
        customer.id,
        "in_progress",
        "temporary review incomplete fixture"
      );
      const otherBooking = await insertBooking(
        otherCustomer.id,
        "completed",
        "temporary review other customer fixture"
      );

      ids.completedBookingId = completedBooking.id;
      ids.pendingBookingId = pendingBooking.id;
      ids.otherBookingId = otherBooking.id;

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

    const unauthenticated = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        booking_id: ids.completedBookingId,
        rating: 5,
      }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidRating = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: authHeaders("customer", ids.customerId),
      body: JSON.stringify({
        booking_id: ids.completedBookingId,
        rating: 6,
      }),
    });
    assert.equal(invalidRating.status, 400);

    const pendingReview = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: authHeaders("customer", ids.customerId),
      body: JSON.stringify({
        booking_id: ids.pendingBookingId,
        rating: 4,
      }),
    });
    assert.equal(pendingReview.status, 409);

    const otherCustomerReview = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: authHeaders("customer", ids.otherCustomerId),
      body: JSON.stringify({
        booking_id: ids.completedBookingId,
        rating: 3,
      }),
    });
    assert.equal(otherCustomerReview.status, 404);

    const ownedReview = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: authHeaders("customer", ids.customerId),
      body: JSON.stringify({
        booking_id: ids.completedBookingId,
        rating: 5,
        comment: "Temporary PostgreSQL review integration",
      }),
    });
    assert.equal(ownedReview.status, 201);
    const ownedReviewBody = await ownedReview.json();
    ids.reviewId = ownedReviewBody.data.id;

    const storedReview = await pool.query(
      `SELECT booking_id, customer_id, barber_id, rating, comment
       FROM reviews
       WHERE id = $1`,
      [ids.reviewId]
    );
    assert.equal(storedReview.rows.length, 1);
    assert.equal(storedReview.rows[0].booking_id, ids.completedBookingId);
    assert.equal(storedReview.rows[0].customer_id, ids.customerId);
    assert.equal(storedReview.rows[0].barber_id, ids.barberId);
    assert.equal(storedReview.rows[0].rating, 5);

    const duplicateReview = await fetch(`${baseUrl}/api/reviews`, {
      method: "POST",
      headers: authHeaders("customer", ids.customerId),
      body: JSON.stringify({
        booking_id: ids.completedBookingId,
        rating: 4,
      }),
    });
    assert.equal(duplicateReview.status, 409);

    const myReviews = await fetch(`${baseUrl}/api/reviews/my`, {
      headers: authHeaders("customer", ids.customerId),
    });
    assert.equal(myReviews.status, 200);
    const myReviewsBody = await myReviews.json();
    assert.equal(
      myReviewsBody.data.some((review) => review.id === ids.reviewId),
      true
    );

    const barberReviews = await fetch(
      `${baseUrl}/api/reviews/barber/${ids.barberId}`
    );
    assert.equal(barberReviews.status, 200);
    const barberReviewsBody = await barberReviews.json();
    assert.equal(
      barberReviewsBody.data.reviews.some(
        (review) => review.id === ids.reviewId
      ),
      true
    );
    assert.equal(Number(barberReviewsBody.data.summary.average_rating), 5);
    assert.equal(barberReviewsBody.data.summary.review_count, 1);

    const barberDetail = await fetch(`${baseUrl}/api/reviews/${ids.reviewId}`, {
      headers: authHeaders("barber", ids.barberUserId),
    });
    assert.equal(barberDetail.status, 200);

    const customerDetail = await fetch(
      `${baseUrl}/api/reviews/${ids.reviewId}`,
      { headers: authHeaders("customer", ids.customerId) }
    );
    assert.equal(customerDetail.status, 200);

    const crossCustomerDetail = await fetch(
      `${baseUrl}/api/reviews/${ids.reviewId}`,
      { headers: authHeaders("customer", ids.otherCustomerId) }
    );
    assert.equal(crossCustomerDetail.status, 404);
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
        if (ids.reviewId) {
          await cleanup.query("DELETE FROM reviews WHERE id = $1", [ids.reviewId]);
        } else if (ids.completedBookingId) {
          await cleanup.query(
            "DELETE FROM reviews WHERE booking_id = $1",
            [ids.completedBookingId]
          );
        }

        const bookingIds = [
          ids.completedBookingId,
          ids.pendingBookingId,
          ids.otherBookingId,
        ].filter(Boolean);
        if (bookingIds.length > 0) {
          await cleanup.query(
            "DELETE FROM bookings WHERE id = ANY($1::uuid[])",
            [bookingIds]
          );
        }
        if (ids.barberId) {
          await cleanup.query("DELETE FROM barbers WHERE id = $1", [ids.barberId]);
        }
        if (ids.barberUserId) {
          await cleanup.query("DELETE FROM users WHERE id = $1", [ids.barberUserId]);
        }
        if (ids.customerId) {
          await cleanup.query("DELETE FROM users WHERE id = $1", [ids.customerId]);
        }
        if (ids.otherCustomerId) {
          await cleanup.query("DELETE FROM users WHERE id = $1", [ids.otherCustomerId]);
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
