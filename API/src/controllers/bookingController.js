const crypto = require("node:crypto");
const pool = require("../config/database");
const HttpError = require("../utils/HttpError");
const {
  bookingIdSchema,
  bookingStatusSchema,
  createBookingSchema,
  bookingListQuerySchema,
  updateBookingStatusSchema,
} = require("../validators/bookingValidator");
const {
  createQueueForConfirmedBooking,
  refreshQueueEta,
} = require("./queueController");
const {
  awardCompletedBookingPoints,
} = require("../services/loyaltyService");
const { loadActiveServices } = require("../services/bookingPricingService");
const {
  reserveVoucher,
  releaseVoucherUsage,
} = require("../services/voucherService");

const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || "Asia/Jakarta";
const businessTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const WEEKDAY_NUMBERS = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

class RequestError extends HttpError {}

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

const respondWithDatabaseError = (res, error, operation, message) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "Reservasi bertabrakan atau kode reservasi duplikat",
    });
  }

  console.error(`${operation} error:`, error.message);
  return res.status(500).json({
    success: false,
    message,
  });
};

const getBusinessDateTime = (date) => {
  const parts = Object.fromEntries(
    businessTimeFormatter
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );

  return {
    dayOfWeek: WEEKDAY_NUMBERS[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
};

const lockCustomer = async (client, customerId) => {
  const result = await client.query(
    `SELECT id
     FROM users
     WHERE id = $1 AND role = 'customer' AND is_active = TRUE
     FOR SHARE`,
    [customerId]
  );

  if (result.rows.length === 0) {
    throw new RequestError(403, "Akun customer tidak aktif");
  }
};

const lockAvailableBarber = async (client, barberId) => {
  const result = await client.query(
    `SELECT b.id,
            b.is_available,
            u.is_active AS user_is_active
     FROM barbers b
     JOIN users u ON u.id = b.user_id
     WHERE b.id = $1 AND u.role = 'barber'
     FOR UPDATE OF b, u`,
    [barberId]
  );

  if (result.rows.length === 0) {
    throw new RequestError(404, "Barber tidak ditemukan");
  }

  if (!result.rows[0].user_is_active || !result.rows[0].is_available) {
    throw new RequestError(409, "Barber sedang tidak tersedia");
  }

  return result.rows[0];
};

const assertScheduleCoversBooking = async (
  client,
  barberId,
  startAt,
  endAt
) => {
  const localStart = getBusinessDateTime(startAt);
  const localEnd = getBusinessDateTime(endAt);

  if (
    localStart.dayOfWeek === undefined ||
    localStart.date !== localEnd.date
  ) {
    throw new RequestError(
      409,
      "Durasi layanan harus berada dalam satu hari kerja barber"
    );
  }

  const result = await client.query(
    `SELECT id
     FROM schedules
     WHERE barber_id = $1
       AND day_of_week = $2
       AND is_available = TRUE
       AND start_time <= $3::time
       AND end_time >= $4::time
     LIMIT 1`,
    [barberId, localStart.dayOfWeek, localStart.time, localEnd.time]
  );

  if (result.rows.length === 0) {
    throw new RequestError(
      409,
      "Waktu reservasi berada di luar jadwal kerja barber"
    );
  }
};

const assertNoBookingOverlap = async (
  client,
  barberId,
  startAt,
  endAt
) => {
  const result = await client.query(
    `SELECT id
     FROM bookings
     WHERE barber_id = $1
       AND status IN ('pending', 'confirmed', 'in_progress')
       AND start_at < $3::timestamptz
       AND end_at > $2::timestamptz
     LIMIT 1`,
    [barberId, startAt.toISOString(), endAt.toISOString()]
  );

  if (result.rows.length > 0) {
    throw new RequestError(409, "Waktu reservasi barber sudah terisi");
  }
};

const getBookingDetails = async (client, bookingId) => {
  const bookingResult = await client.query(
    `SELECT b.id,
            b.booking_code,
            b.customer_id,
            customer.full_name AS customer_name,
            b.barber_id,
            barber_user.full_name AS barber_name,
            b.start_at,
            b.end_at,
            b.status,
            b.total_price,
            b.voucher_id,
            v.code AS voucher_code,
            CASE WHEN b.voucher_id IS NULL THEN 0::numeric
                 ELSE GREATEST(
                   COALESCE((SELECT SUM(bi.subtotal)
                             FROM booking_items bi
                             WHERE bi.booking_id = b.id), 0) - b.total_price,
                   0
                 )
            END AS discount_amount,
            b.notes,
            b.created_at,
            b.updated_at
     FROM bookings b
     JOIN users customer ON customer.id = b.customer_id
     JOIN barbers barber ON barber.id = b.barber_id
     JOIN users barber_user ON barber_user.id = barber.user_id
     LEFT JOIN vouchers v ON v.id = b.voucher_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const itemsResult = await client.query(
    `SELECT id, service_id, service_name, quantity, unit_price,
            duration_minutes, subtotal
     FROM booking_items
     WHERE booking_id = $1
     ORDER BY created_at ASC, id ASC`,
    [bookingId]
  );

  return {
    ...bookingResult.rows[0],
    items: itemsResult.rows,
  };
};

const getBookingScope = (role, userId) => {
  if (role === "admin") {
    return { condition: null, values: [] };
  }
  if (role === "customer") {
    return { condition: "b.customer_id = $1", values: [userId] };
  }
  if (role === "barber") {
    return {
      condition: "b.barber_id = (SELECT id FROM barbers WHERE user_id = $1)",
      values: [userId],
    };
  }

  return null;
};

const getBookings = async (req, res) => {
  const validation = bookingListQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Filter reservasi tidak valid",
      errors: validation.error.issues,
    });
  }

  const scope = getBookingScope(req.user.role, req.user.id);
  if (!scope) {
    return res.status(403).json({
      success: false,
      message: "Role tidak memiliki akses ke reservasi",
    });
  }

  const conditions = [];
  const values = [...scope.values];
  if (scope.condition) {
    conditions.push(scope.condition);
  }
  if (validation.data.status) {
    values.push(validation.data.status);
    conditions.push(`b.status = $${values.length}`);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  try {
    const result = await pool.query(
      `SELECT b.id,
              b.booking_code,
              b.customer_id,
              customer.full_name AS customer_name,
              b.barber_id,
              barber_user.full_name AS barber_name,
              b.start_at,
              b.end_at,
              b.status,
              b.total_price,
              b.created_at,
              (SELECT COUNT(*)::integer
               FROM booking_items bi
               WHERE bi.booking_id = b.id) AS item_count
       FROM bookings b
       JOIN users customer ON customer.id = b.customer_id
       JOIN barbers barber ON barber.id = b.barber_id
       JOIN users barber_user ON barber_user.id = barber.user_id
       ${whereClause}
       ORDER BY b.start_at DESC, b.id ASC`,
      values
    );

    return res.status(200).json({
      success: true,
      message: "Daftar reservasi berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    console.error("Get bookings error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar reservasi",
    });
  }
};

const getBookingById = async (req, res) => {
  const idValidation = bookingIdSchema.safeParse(req.params.id);
  if (!idValidation.success) {
    return res.status(400).json({
      success: false,
      message: "ID reservasi tidak valid",
      errors: idValidation.error.issues,
    });
  }

  const scope = getBookingScope(req.user.role, req.user.id);
  if (!scope) {
    return res.status(403).json({
      success: false,
      message: "Role tidak memiliki akses ke reservasi",
    });
  }

  const values = [idValidation.data, ...scope.values];
  const condition = scope.condition
    ? `AND ${scope.condition.replace(/\$1/g, "$2")}`
    : "";

  try {
    const result = await pool.query(
      `SELECT b.id,
              b.booking_code,
              b.customer_id,
              customer.full_name AS customer_name,
              b.barber_id,
              barber_user.full_name AS barber_name,
              b.start_at,
              b.end_at,
              b.status,
              b.total_price,
              b.voucher_id,
              v.code AS voucher_code,
              CASE WHEN b.voucher_id IS NULL THEN 0::numeric
                   ELSE GREATEST(
                     COALESCE((SELECT SUM(bi.subtotal)
                               FROM booking_items bi
                               WHERE bi.booking_id = b.id), 0) - b.total_price,
                     0
                   )
              END AS discount_amount,
              b.notes,
              b.created_at,
              b.updated_at
       FROM bookings b
       JOIN users customer ON customer.id = b.customer_id
       JOIN barbers barber ON barber.id = b.barber_id
       JOIN users barber_user ON barber_user.id = barber.user_id
       LEFT JOIN vouchers v ON v.id = b.voucher_id
       WHERE b.id = $1 ${condition}`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Reservasi tidak ditemukan",
      });
    }

    const itemsResult = await pool.query(
      `SELECT id, service_id, service_name, quantity, unit_price,
              duration_minutes, subtotal
       FROM booking_items
       WHERE booking_id = $1
       ORDER BY created_at ASC, id ASC`,
      [idValidation.data]
    );

    return res.status(200).json({
      success: true,
      message: "Detail reservasi berhasil diambil",
      data: { ...result.rows[0], items: itemsResult.rows },
    });
  } catch (error) {
    console.error("Get booking error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil detail reservasi",
    });
  }
};

const createBooking = async (req, res) => {
  const validation = createBookingSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data reservasi tidak valid",
      errors: validation.error.issues,
    });
  }

  const booking = validation.data;
  const startAt = new Date(booking.start_at);
  if (startAt.getTime() <= Date.now()) {
    return res.status(400).json({
      success: false,
      message: "Waktu reservasi harus berada di masa depan",
    });
  }

  try {
    const createdBooking = await withTransaction(async (client) => {
      await lockCustomer(client, req.user.id);
      await lockAvailableBarber(client, booking.barber_id);
      const { itemSnapshots, totalDuration, totalPriceCents } =
        await loadActiveServices(client, booking.items);
      let totalPrice = (totalPriceCents / 100).toFixed(2);
      let voucherId = null;
      if (booking.voucher_code) {
        const reservedVoucher = await reserveVoucher(
          client,
          booking.voucher_code,
          totalPriceCents
        );
        voucherId = reservedVoucher.voucher.id;
        totalPrice = reservedVoucher.totalPrice;
      }

      if (totalDuration > 24 * 60) {
        throw new RequestError(409, "Durasi layanan melebihi satu hari");
      }

      const endAt = new Date(startAt.getTime() + totalDuration * 60_000);
      if (!Number.isFinite(endAt.getTime()) || startAt.getTime() <= Date.now()) {
        throw new RequestError(409, "Waktu reservasi sudah tidak valid");
      }

      await assertScheduleCoversBooking(
        client,
        booking.barber_id,
        startAt,
        endAt
      );
      await assertNoBookingOverlap(
        client,
        booking.barber_id,
        startAt,
        endAt
      );

      const bookingCode = `CK-${crypto.randomBytes(12)
        .toString("hex")
        .toUpperCase()}`;
      const bookingResult = await client.query(
        `INSERT INTO bookings (
           customer_id, barber_id, booking_code, start_at, end_at,
           status, total_price, notes, voucher_id
         )
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
                 'pending', $6, $7, $8)
         RETURNING id`,
        [
          req.user.id,
          booking.barber_id,
          bookingCode,
          startAt.toISOString(),
          endAt.toISOString(),
          totalPrice,
          booking.notes ?? null,
          voucherId,
        ]
      );
      const bookingId = bookingResult.rows[0].id;

      for (const item of itemSnapshots) {
        await client.query(
          `INSERT INTO booking_items (
             booking_id, service_id, service_name, quantity, unit_price,
             duration_minutes
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            bookingId,
            item.id,
            item.service_name,
            item.quantity,
            item.price,
            item.duration_minutes,
          ]
        );
      }

      return getBookingDetails(client, bookingId);
    }, "Create booking");

    return res.status(201).json({
      success: true,
      message: "Reservasi berhasil dibuat",
      data: createdBooking,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Create booking",
      "Gagal membuat reservasi"
    );
  }
};

const lockBookingBarber = async (client, bookingId) => {
  const bookingResult = await client.query(
    "SELECT barber_id FROM bookings WHERE id = $1",
    [bookingId]
  );

  if (bookingResult.rows.length === 0) {
    throw new RequestError(404, "Reservasi tidak ditemukan");
  }

  const barberResult = await client.query(
    `SELECT id, user_id
     FROM barbers
     WHERE id = $1
     FOR UPDATE`,
    [bookingResult.rows[0].barber_id]
  );

  if (barberResult.rows.length === 0) {
    throw new RequestError(404, "Barber reservasi tidak ditemukan");
  }

  return barberResult.rows[0];
};

const cancelBooking = async (req, res) => {
  const validation = bookingIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID reservasi tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const booking = await withTransaction(async (client) => {
      await lockBookingBarber(client, validation.data);
      const currentResult = await client.query(
        `SELECT id, status, voucher_id
         FROM bookings
         WHERE id = $1 AND customer_id = $2
         FOR UPDATE`,
        [validation.data, req.user.id]
      );

      if (currentResult.rows.length === 0) {
        throw new RequestError(404, "Reservasi tidak ditemukan");
      }
      if (!["pending", "confirmed"].includes(currentResult.rows[0].status)) {
        throw new RequestError(
          409,
          "Reservasi dengan status ini tidak dapat dibatalkan"
        );
      }

      const updateResult = await client.query(
        `UPDATE bookings
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND customer_id = $2
           AND status IN ('pending', 'confirmed')
           AND start_at > statement_timestamp()
         RETURNING id, status, updated_at`,
        [validation.data, req.user.id]
      );

      if (updateResult.rows.length === 0) {
        throw new RequestError(
          409,
          "Reservasi sudah dimulai atau statusnya telah berubah"
        );
      }

      if (currentResult.rows[0].voucher_id) {
        await releaseVoucherUsage(client, currentResult.rows[0].voucher_id);
      }

      await client.query(
        `UPDATE queues
         SET status = 'cancelled',
             cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE booking_id = $1
           AND status IN ('waiting', 'called', 'serving')`,
        [validation.data]
      );
      const queueDateResult = await client.query(
        `SELECT queue_date, barber_id
         FROM queues
         WHERE booking_id = $1
         LIMIT 1`,
        [validation.data]
      );
      if (queueDateResult.rows.length > 0) {
        await refreshQueueEta(
          client,
          queueDateResult.rows[0].barber_id,
          queueDateResult.rows[0].queue_date
        );
      }

      return updateResult.rows[0];
    }, "Cancel booking");

    return res.status(200).json({
      success: true,
      message: "Reservasi berhasil dibatalkan",
      data: booking,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Cancel booking",
      "Gagal membatalkan reservasi"
    );
  }
};

const TRANSITIONS_BY_ROLE = {
  admin: {
    pending: ["confirmed", "cancelled"],
    confirmed: ["in_progress", "cancelled", "no_show"],
    in_progress: ["completed"],
  },
  barber: {
    pending: ["confirmed", "cancelled"],
    confirmed: ["in_progress"],
    in_progress: ["completed"],
  },
};

const updateBookingStatus = async (req, res) => {
  const idValidation = bookingIdSchema.safeParse(req.params.id);
  if (!idValidation.success) {
    return res.status(400).json({
      success: false,
      message: "ID reservasi tidak valid",
      errors: idValidation.error.issues,
    });
  }

  const validation = updateBookingStatusSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Status reservasi tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const booking = await withTransaction(async (client) => {
      const barber = await lockBookingBarber(client, idValidation.data);
      if (req.user.role === "barber" && barber.user_id !== req.user.id) {
        throw new RequestError(404, "Reservasi tidak ditemukan");
      }

      const currentResult = await client.query(
        `SELECT id, status, start_at, voucher_id,
                start_at <= statement_timestamp() AS has_started
         FROM bookings
         WHERE id = $1
         FOR UPDATE`,
        [idValidation.data]
      );
      if (currentResult.rows.length === 0) {
        throw new RequestError(404, "Reservasi tidak ditemukan");
      }

      const current = currentResult.rows[0];
      const allowedNextStatuses =
        TRANSITIONS_BY_ROLE[req.user.role]?.[current.status] || [];
      if (!allowedNextStatuses.includes(validation.data.status)) {
        throw new RequestError(
          409,
          `Status ${current.status} tidak dapat diubah menjadi ${validation.data.status}`
        );
      }
      if (
        validation.data.status === "no_show" &&
        !current.has_started
      ) {
        throw new RequestError(
          409,
          "Reservasi hanya dapat ditandai no-show setelah waktu mulai"
        );
      }

      const updateResult = await client.query(
        `UPDATE bookings
         SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, status, updated_at`,
        [idValidation.data, validation.data.status]
      );

      if (validation.data.status === "completed") {
        await awardCompletedBookingPoints(client, idValidation.data);
      }

      if (validation.data.status === "confirmed") {
        await createQueueForConfirmedBooking(client, idValidation.data);
      }

      if (validation.data.status === "cancelled") {
        if (current.voucher_id) {
          await releaseVoucherUsage(client, current.voucher_id);
        }
        await client.query(
          `UPDATE queues
           SET status = 'cancelled',
               cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE booking_id = $1
             AND status IN ('waiting', 'called', 'serving')`,
          [idValidation.data]
        );
      }

      if (["in_progress", "completed", "cancelled"].includes(validation.data.status)) {
        const queueDateResult = await client.query(
          `SELECT queue_date, barber_id
           FROM queues
           WHERE booking_id = $1
           LIMIT 1`,
          [idValidation.data]
        );
        if (validation.data.status === "completed") {
          await client.query(
            `UPDATE queues
             SET status = 'completed',
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE booking_id = $1
               AND status = 'serving'`,
            [idValidation.data]
          );
        }
        if (validation.data.status === "in_progress") {
          await client.query(
            `UPDATE queues
             SET status = 'serving',
                 started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE booking_id = $1
               AND status IN ('waiting', 'called')`,
            [idValidation.data]
          );
        }
        if (queueDateResult.rows.length > 0) {
          await refreshQueueEta(
            client,
            queueDateResult.rows[0].barber_id,
            queueDateResult.rows[0].queue_date
          );
        }
      }

      return updateResult.rows[0];
    }, "Update booking status");

    return res.status(200).json({
      success: true,
      message: "Status reservasi berhasil diperbarui",
      data: booking,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Update booking status",
      "Gagal memperbarui status reservasi"
    );
  }
};

module.exports = {
  getBookings,
  getBookingById,
  createBooking,
  cancelBooking,
  updateBookingStatus,
};
