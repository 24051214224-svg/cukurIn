const pool = require("../config/database");
const {
  reviewIdSchema,
  barberIdSchema,
  createReviewSchema,
} = require("../validators/reviewValidator");

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const withTransaction = async (operation, label) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(`${label} rollback error:`, rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
};

const respondError = (res, error, operation, fallbackMessage) => {
  if (error instanceof RequestError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }
  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "Booking ini sudah memiliki review",
    });
  }
  console.error(`${operation} error:`, error.message);
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
};

const createReview = async (req, res) => {
  const validation = createReviewSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data review tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const review = await withTransaction(async (client) => {
      const bookingResult = await client.query(
        `SELECT b.id, b.customer_id, b.barber_id, b.status,
                barber.user_id AS barber_user_id
         FROM bookings b
         JOIN barbers barber ON barber.id = b.barber_id
         WHERE b.id = $1
         FOR UPDATE OF b`,
        [validation.data.booking_id]
      );

      if (bookingResult.rows.length === 0) {
        throw new RequestError(404, "Booking tidak ditemukan");
      }

      const booking = bookingResult.rows[0];
      if (booking.customer_id !== req.user.id) {
        throw new RequestError(404, "Booking tidak ditemukan");
      }
      if (booking.status !== "completed") {
        throw new RequestError(
          409,
          "Review hanya dapat dibuat untuk booking yang sudah selesai"
        );
      }

      const existing = await client.query(
        "SELECT id FROM reviews WHERE booking_id = $1",
        [booking.id]
      );
      if (existing.rows.length > 0) {
        throw new RequestError(409, "Booking ini sudah memiliki review");
      }

      const inserted = await client.query(
        `INSERT INTO reviews (
           booking_id, customer_id, barber_id, rating, comment
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, booking_id, customer_id, barber_id, rating, comment, created_at`,
        [
          booking.id,
          req.user.id,
          booking.barber_id,
          validation.data.rating,
          validation.data.comment ?? null,
        ]
      );
      return inserted.rows[0];
    }, "Create review");

    return res.status(201).json({
      success: true,
      message: "Review berhasil dibuat",
      data: review,
    });
  } catch (error) {
    return respondError(res, error, "Create review", "Gagal membuat review");
  }
};

const getBarberReviews = async (req, res) => {
  const validation = barberIdSchema.safeParse(req.params.barberId);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
    });
  }

  try {
    const barber = await pool.query(
      `SELECT b.id
       FROM barbers b
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND u.role = 'barber' AND u.is_active = TRUE`,
      [validation.data]
    );
    if (barber.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Barber tidak ditemukan",
      });
    }

    const result = await pool.query(
      `SELECT r.id, r.booking_id, r.customer_id, r.barber_id,
              r.rating, r.comment, r.created_at,
              customer.full_name AS customer_name
       FROM reviews r
       JOIN users customer ON customer.id = r.customer_id
       WHERE r.barber_id = $1
       ORDER BY r.created_at DESC, r.id DESC`,
      [validation.data]
    );

    const summary = await pool.query(
      `SELECT COALESCE(AVG(rating)::numeric(3, 2), 0)::numeric(3, 2)
              AS average_rating,
              COUNT(*)::integer AS review_count
       FROM reviews
       WHERE barber_id = $1`,
      [validation.data]
    );

    return res.status(200).json({
      success: true,
      message: "Daftar review barber berhasil diambil",
      data: {
        summary: summary.rows[0],
        reviews: result.rows,
      },
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Get barber reviews",
      "Gagal mengambil review barber"
    );
  }
};

const getMyReviews = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.booking_id, r.customer_id, r.barber_id,
              r.rating, r.comment, r.created_at,
              barber_user.full_name AS barber_name
       FROM reviews r
       JOIN barbers barber ON barber.id = r.barber_id
       JOIN users barber_user ON barber_user.id = barber.user_id
       WHERE r.customer_id = $1
       ORDER BY r.created_at DESC, r.id DESC`,
      [req.user.id]
    );
    return res.status(200).json({
      success: true,
      message: "Daftar review Anda berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Get my reviews",
      "Gagal mengambil review Anda"
    );
  }
};

const getReviewById = async (req, res) => {
  const validation = reviewIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID review tidak valid",
    });
  }

  const values = [validation.data];
  let scopeClause = "";
  if (req.user.role === "customer") {
    values.push(req.user.id);
    scopeClause = " AND r.customer_id = $2";
  } else if (req.user.role === "barber") {
    values.push(req.user.id);
    scopeClause =
      " AND r.barber_id = (SELECT id FROM barbers WHERE user_id = $2)";
  }

  try {
    const result = await pool.query(
      `SELECT r.id, r.booking_id, r.customer_id, r.barber_id,
              r.rating, r.comment, r.created_at,
              customer.full_name AS customer_name,
              barber_user.full_name AS barber_name
       FROM reviews r
       JOIN users customer ON customer.id = r.customer_id
       JOIN barbers barber ON barber.id = r.barber_id
       JOIN users barber_user ON barber_user.id = barber.user_id
       WHERE r.id = $1${scopeClause}`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Review tidak ditemukan",
      });
    }
    return res.status(200).json({
      success: true,
      message: "Detail review berhasil diambil",
      data: result.rows[0],
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Get review detail",
      "Gagal mengambil detail review"
    );
  }
};

module.exports = {
  createReview,
  getBarberReviews,
  getMyReviews,
  getReviewById,
};
