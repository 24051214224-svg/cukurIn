const pool = require("../config/database");
const {
  queueIdSchema,
  qrTokenSchema,
  checkInByTokenSchema,
} = require("../validators/queueValidator");
const {
  awardCompletedBookingPoints,
} = require("../services/loyaltyService");
const {
  notifyBookingCancelled,
  notifyQueueStatus,
} = require("../services/notificationService");

const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || "Asia/Jakarta";
const ACTIVE_STATUSES = ["waiting", "called", "serving"];

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
      message: "Antrean sudah digunakan atau nomor antrean duplikat",
    });
  }
  console.error(`${operation} error:`, error.stack || error.message);
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
};

const localIso = (date) => {
  const value = new Date(date);
  if (!Number.isFinite(value.getTime())) return null;
  return value.toISOString();
};

const getDurationMinutes = (rows) =>
  rows.reduce(
    (total, row) =>
      total +
      Math.max(0, Number(row.duration_minutes || 0)) *
        Math.max(1, Number(row.quantity || 1)),
    0
  );

const calculateSmartEta = (queues, now = Date.now()) => {
  let cursor = now;
  let hasServing = false;
  const estimates = new Map();

  for (const queue of queues
    .filter((item) => ACTIVE_STATUSES.includes(item.status))
    .sort((a, b) =>
      Number(a.queue_number) - Number(b.queue_number) ||
      String(a.id).localeCompare(String(b.id))
    )) {
    let start;
    let end;
    const durationMinutes = Math.max(
      1,
      Number(queue.duration_minutes || 0)
    );

    if (queue.status === "serving") {
      hasServing = true;
      const servingStart = queue.started_at
        ? new Date(queue.started_at).getTime()
        : new Date(queue.updated_at).getTime();
      start = Number.isFinite(servingStart) ? servingStart : now;
      end = start + durationMinutes * 60_000;
      cursor = Math.max(cursor, end);
    } else {
      const appointment = new Date(queue.booking_start_at).getTime();
      start = hasServing
        ? cursor
        : Math.max(cursor, Number.isFinite(appointment) ? appointment : now);
      end = start + durationMinutes * 60_000;
      cursor = end;
    }

    estimates.set(queue.id, {
      estimated_start_at: new Date(Math.max(now, start)).toISOString(),
      estimated_end_at: new Date(Math.max(now, end)).toISOString(),
      wait_minutes: Math.max(
        0,
        Math.ceil((Math.max(now, start) - now) / 60_000)
      ),
    });
  }

  return estimates;
};

const loadQueueDetails = async (client, queueId) => {
  const result = await client.query(
    `SELECT q.id, q.booking_id, q.barber_id, q.queue_date, q.queue_number,
            q.status, q.estimated_start_at, q.estimated_end_at,
            q.checked_in_at, q.started_at, q.completed_at, q.cancelled_at,
            q.created_at, q.updated_at,
            b.customer_id, b.start_at AS booking_start_at,
            b.end_at AS booking_end_at, b.status AS booking_status,
            customer.full_name AS customer_name,
            barber_user.full_name AS barber_name
     FROM queues q
     JOIN bookings b ON b.id = q.booking_id
     JOIN users customer ON customer.id = b.customer_id
     JOIN barbers barber ON barber.id = q.barber_id
     JOIN users barber_user ON barber_user.id = barber.user_id
     WHERE q.id = $1`,
    [queueId]
  );
  if (result.rows.length === 0) return null;

  const items = await client.query(
    `SELECT service_name, quantity, duration_minutes
     FROM booking_items
     WHERE booking_id = $1
     ORDER BY created_at ASC, id ASC`,
    [result.rows[0].booking_id]
  );
  return { ...result.rows[0], items: items.rows,
    duration_minutes: getDurationMinutes(items.rows) };
};

const refreshQueueEta = async (client, barberId, queueDate) => {
  await client.query(
    `UPDATE queues
     SET estimated_start_at = NULL,
         estimated_end_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE barber_id = $1
       AND queue_date = $2::date
       AND status IN ('completed', 'cancelled')`,
    [barberId, queueDate]
  );
  const result = await client.query(
    `SELECT q.id, q.status, q.queue_number, q.started_at, q.updated_at,
            b.start_at AS booking_start_at,
            COALESCE((
              SELECT SUM(bi.duration_minutes * bi.quantity)
              FROM booking_items bi
              WHERE bi.booking_id = b.id
            ), 0)::integer AS duration_minutes
     FROM queues q
     JOIN bookings b ON b.id = q.booking_id
     WHERE q.barber_id = $1
       AND q.queue_date = $2::date
       AND q.status = ANY($3::varchar[])
     ORDER BY q.queue_number ASC, q.id ASC`,
    [barberId, queueDate, ACTIVE_STATUSES]
  );
  const estimates = calculateSmartEta(result.rows);
  for (const queue of result.rows) {
    const estimate = estimates.get(queue.id);
    if (!estimate) continue;
    await client.query(
      `UPDATE queues
       SET estimated_start_at = $2::timestamptz,
           estimated_end_at = $3::timestamptz,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [queue.id, estimate.estimated_start_at, estimate.estimated_end_at]
    );
  }
};

const getLocalQueueDate = (bookingStartAt) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    }).formatToParts(new Date(bookingStartAt))
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const createQueueForConfirmedBooking = async (client, bookingId) => {
  const existing = await client.query(
    "SELECT id FROM queues WHERE booking_id = $1",
    [bookingId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const bookingReference = await client.query(
    "SELECT barber_id FROM bookings WHERE id = $1",
    [bookingId]
  );
  if (bookingReference.rows.length === 0) {
    throw new RequestError(404, "Reservasi tidak ditemukan");
  }
  await lockBarberRow(client, bookingReference.rows[0].barber_id);

  const booking = await client.query(
    `SELECT b.id, b.barber_id, b.customer_id, b.start_at, b.status
     FROM bookings b
     WHERE b.id = $1
     FOR UPDATE`,
    [bookingId]
  );
  if (booking.rows.length === 0) {
    throw new RequestError(404, "Reservasi tidak ditemukan");
  }
  if (booking.rows[0].barber_id !== bookingReference.rows[0].barber_id) {
    throw new RequestError(409, "Barber reservasi sudah berubah");
  }
  if (booking.rows[0].status !== "confirmed") return null;

  const queueDate = getLocalQueueDate(booking.rows[0].start_at);
  const numberResult = await client.query(
    `SELECT COALESCE(MAX(queue_number), 0)::integer + 1 AS next_number
     FROM queues
     WHERE barber_id = $1 AND queue_date = $2::date`,
    [booking.rows[0].barber_id, queueDate]
  );

  const result = await client.query(
    `INSERT INTO queues (
       booking_id, barber_id, queue_date, queue_number, status
     )
     VALUES ($1, $2, $3::date, $4, 'waiting')
     RETURNING id`,
    [
      bookingId,
      booking.rows[0].barber_id,
      queueDate,
      numberResult.rows[0].next_number,
    ]
  );
  await refreshQueueEta(client, booking.rows[0].barber_id, queueDate);
  return result.rows[0];
};

const lockQueueForRole = async (client, queueId, user) => {
  const barberRef = await client.query(
    "SELECT barber_id FROM queues WHERE id = $1",
    [queueId]
  );
  if (barberRef.rows.length === 0) {
    throw new RequestError(404, "Antrean tidak ditemukan");
  }

  await lockBarberRow(client, barberRef.rows[0].barber_id);

  const result = await client.query(
    `SELECT q.id, q.booking_id, q.barber_id, q.queue_date, q.queue_number,
            q.status, q.checked_in_at, q.started_at,
            b.customer_id, b.booking_code, b.status AS booking_status,
            barber.user_id AS barber_user_id
     FROM queues q
     JOIN bookings b ON b.id = q.booking_id
     JOIN barbers barber ON barber.id = q.barber_id
     WHERE q.id = $1
     FOR UPDATE OF q, b`,
    [queueId]
  );
  if (result.rows.length === 0) {
    throw new RequestError(404, "Antrean tidak ditemukan");
  }
  const queue = result.rows[0];

  if (user.role === "customer" && queue.customer_id !== user.id) {
    throw new RequestError(404, "Antrean tidak ditemukan");
  }
  if (user.role === "barber" && queue.barber_user_id !== user.id) {
    throw new RequestError(404, "Antrean tidak ditemukan");
  }
  return queue;
};

const lockBarberRow = async (client, barberId) => {
  const barber = await client.query(
    "SELECT id FROM barbers WHERE id = $1 FOR UPDATE",
    [barberId]
  );
  if (barber.rows.length === 0) {
    throw new RequestError(404, "Barber tidak ditemukan");
  }
  return barber;
};

const lockBarberForServing = async (client, barberId, excludeQueueId = null) => {
  const barber = await lockBarberRow(client, barberId);

  const serving = await client.query(
    `SELECT id, queue_number
     FROM queues
     WHERE barber_id = $1
       AND status = 'serving'
       AND ($2::uuid IS NULL OR id <> $2::uuid)
     ORDER BY started_at ASC NULLS LAST, queue_number ASC, id ASC
     LIMIT 1
     FOR UPDATE`,
    [barberId, excludeQueueId]
  );
  if (serving.rows.length > 0) {
    throw new RequestError(
      409,
      "Barber masih melayani pelanggan lain. Selesaikan layanan aktif sebelum memulai antrean berikutnya."
    );
  }

  return barber.rows[0];
};

const getMyQueues = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q.id, q.booking_id, q.barber_id, q.queue_date, q.queue_number,
              q.status, q.estimated_start_at, q.estimated_end_at,
              q.checked_in_at, q.started_at, q.completed_at, q.cancelled_at,
              barber_user.full_name AS barber_name,
              b.status AS booking_status
       FROM queues q
       JOIN bookings b ON b.id = q.booking_id
       JOIN barbers barber ON barber.id = q.barber_id
       JOIN users barber_user ON barber_user.id = barber.user_id
       WHERE b.customer_id = $1
       ORDER BY q.queue_date DESC, q.queue_number ASC`,
      [req.user.id]
    );
    return res.status(200).json({
      success: true,
      message: "Daftar antrean berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    return respondError(res, error, "Get my queues", "Gagal mengambil antrean");
  }
};

const getTodayQueues = async (req, res) => {
  const validation = require("../validators/queueValidator")
    .barberIdSchema.safeParse(req.params.barberId);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "ID barber tidak valid" });
  }

  try {
    const result = await withTransaction(async (client) => {
      if (req.user.role === "barber") {
        const owned = await client.query(
          "SELECT id FROM barbers WHERE id = $1 AND user_id = $2",
          [validation.data, req.user.id]
        );
        if (owned.rows.length === 0) {
          throw new RequestError(404, "Barber tidak ditemukan");
        }
      }
      await lockBarberRow(client, validation.data);

      const today = getLocalQueueDate(new Date().toISOString());
      await refreshQueueEta(client, validation.data, today);
      const queues = await client.query(
        `SELECT q.id, q.booking_id, q.queue_number, q.status,
                q.estimated_start_at, q.estimated_end_at,
                q.checked_in_at, q.started_at, q.completed_at, q.cancelled_at,
                b.customer_id, customer.full_name AS customer_name
         FROM queues q
         JOIN bookings b ON b.id = q.booking_id
         JOIN users customer ON customer.id = b.customer_id
         WHERE q.barber_id = $1
           AND q.queue_date = $2::date
         ORDER BY q.queue_number ASC`,
        [validation.data, today]
      );
      return queues.rows;
    }, "Get today's queues");

    return res.status(200).json({
      success: true,
      message: "Antrean harian berhasil diambil",
      data: result,
    });
  } catch (error) {
    return respondError(res, error, "Get today's queues", "Gagal mengambil antrean harian");
  }
};

const getQueueById = async (req, res) => {
  const validation = queueIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "ID antrean tidak valid" });
  }
  try {
    const result = await withTransaction(async (client) => {
      const queue = await lockQueueForRole(client, validation.data, req.user);
      await refreshQueueEta(client, queue.barber_id, queue.queue_date);
      return loadQueueDetails(client, queue.id);
    }, "Get queue detail");
    return res.status(200).json({
      success: true,
      message: "Detail antrean berhasil diambil",
      data: result,
    });
  } catch (error) {
    return respondError(res, error, "Get queue detail", "Gagal mengambil detail antrean");
  }
};

const callQueue = async (req, res) => changeQueueStatus(req, res, "called");
const startQueue = async (req, res) => changeQueueStatus(req, res, "serving");
const completeQueue = async (req, res) => changeQueueStatus(req, res, "completed");

const changeQueueStatus = async (req, res, nextStatus) => {
  const validation = queueIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "ID antrean tidak valid" });
  }
  const allowed = {
    called: ["waiting"],
    serving: ["called", "waiting"],
    completed: ["serving"],
  };

  try {
    const queue = await withTransaction(async (client) => {
      const current = await lockQueueForRole(client, validation.data, req.user);
      if (!allowed[nextStatus].includes(current.status)) {
        throw new RequestError(
          409,
          `Status antrean ${current.status} tidak dapat diubah menjadi ${nextStatus}`
        );
      }
      if (nextStatus === "serving") {
        await lockBarberForServing(client, current.barber_id, current.id);
      }
      let extraSet = "";
      if (nextStatus === "serving") {
        extraSet = ", started_at = COALESCE(started_at, CURRENT_TIMESTAMP)";
      }
      if (nextStatus === "completed") {
        extraSet = ", completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)";
      }
      const queueUpdate = await client.query(
        `UPDATE queues
         SET status = $2, updated_at = CURRENT_TIMESTAMP ${extraSet}
         WHERE id = $1
         RETURNING id, queue_number`,
        [current.id, nextStatus]
      );
      if (queueUpdate.rows.length === 0) {
        throw new RequestError(409, "Status antrean sudah berubah");
      }

      const bookingStatus =
        nextStatus === "serving"
          ? "in_progress"
          : nextStatus === "completed"
            ? "completed"
            : null;
      if (bookingStatus) {
        const bookingUpdate = await client.query(
          `UPDATE bookings
           SET status = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING id`,
          [current.booking_id, bookingStatus]
        );
        if (bookingUpdate.rows.length === 0) {
          throw new RequestError(409, "Status reservasi sudah berubah");
        }
      }
      if (bookingStatus === "completed") {
        await awardCompletedBookingPoints(client, current.booking_id);
      }
      await notifyQueueStatus(
        client,
        {
          customerId: current.customer_id,
          bookingCode: current.booking_code,
          queueNumber: current.queue_number,
        },
        nextStatus
      );
      await refreshQueueEta(client, current.barber_id, current.queue_date);
      return loadQueueDetails(client, current.id);
    }, `Change queue to ${nextStatus}`);

    return res.status(200).json({
      success: true,
      message: `Status antrean berhasil diubah menjadi ${nextStatus}`,
      data: queue,
    });
  } catch (error) {
    return respondError(res, error, `Change queue ${nextStatus}`, "Gagal mengubah status antrean");
  }
};

const cancelQueue = async (req, res) => {
  const validation = queueIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "ID antrean tidak valid" });
  }
  try {
    const queue = await withTransaction(async (client) => {
      const current = await lockQueueForRole(client, validation.data, req.user);
      if (!ACTIVE_STATUSES.includes(current.status)) {
        throw new RequestError(409, "Antrean ini tidak dapat dibatalkan");
      }
      if (current.status === "serving" && req.user.role !== "admin") {
        throw new RequestError(409, "Layanan yang sedang berlangsung tidak dapat dibatalkan");
      }

      const queueUpdate = await client.query(
        `UPDATE queues
         SET status = 'cancelled',
             cancelled_at = COALESCE(cancelled_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id`,
        [current.id]
      );
      if (queueUpdate.rows.length === 0) {
        throw new RequestError(409, "Status antrean sudah berubah");
      }
      const bookingUpdate = await client.query(
        `UPDATE bookings
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status IN ('pending', 'confirmed', 'in_progress')
         RETURNING id`,
        [current.booking_id]
      );
      if (bookingUpdate.rows.length > 0) {
        await notifyBookingCancelled(client, {
          customerId: current.customer_id,
          barberUserId: current.barber_user_id,
          bookingCode: current.booking_code,
        });
      }
      await refreshQueueEta(client, current.barber_id, current.queue_date);
      return loadQueueDetails(client, current.id);
    }, "Cancel queue");

    return res.status(200).json({
      success: true,
      message: "Antrean berhasil dibatalkan",
      data: queue,
    });
  } catch (error) {
    return respondError(res, error, "Cancel queue", "Gagal membatalkan antrean");
  }
};

const checkInQueue = async (req, res) => {
  const validation = queueIdSchema.safeParse(req.params.id);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "ID antrean tidak valid" });
  }
  const tokenValidation = qrTokenSchema.safeParse(req.body?.qr_token);
  if (!tokenValidation.success) {
    return res.status(400).json({ success: false, message: "QR token tidak valid" });
  }
  return performCheckIn(res, req.user, validation.data, tokenValidation.data);
};

const checkInByToken = async (req, res) => {
  const validation = checkInByTokenSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ success: false, message: "QR token tidak valid" });
  }
  return performCheckIn(res, req.user, null, validation.data.qr_token);
};

const performCheckIn = async (res, user, queueId, token) => {
  try {
    const queue = await withTransaction(async (client) => {
      const barberReference = await client.query(
        `SELECT q.barber_id
         FROM queues q
         WHERE q.qr_token = $1
           AND ($2::uuid IS NULL OR q.id = $2::uuid)`,
        [token, queueId]
      );
      if (barberReference.rows.length === 0) {
        throw new RequestError(404, "Antrean atau QR token tidak ditemukan");
      }
      await lockBarberRow(client, barberReference.rows[0].barber_id);

      const result = await client.query(
        `SELECT q.id, q.barber_id, q.queue_date, q.status, q.checked_in_at,
                b.customer_id
         FROM queues q
         JOIN bookings b ON b.id = q.booking_id
         WHERE q.qr_token = $1
           AND ($2::uuid IS NULL OR q.id = $2::uuid)
         FOR UPDATE OF q`,
        [token, queueId]
      );
      if (result.rows.length === 0) {
        throw new RequestError(404, "Antrean atau QR token tidak ditemukan");
      }
      const current = result.rows[0];
      if (current.barber_id !== barberReference.rows[0].barber_id) {
        throw new RequestError(409, "Barber antrean sudah berubah");
      }
      if (current.customer_id !== user.id) {
        throw new RequestError(404, "Antrean tidak ditemukan");
      }
      if (current.checked_in_at !== null) {
        throw new RequestError(409, "QR token sudah digunakan untuk check-in");
      }
      if (current.status === "completed" || current.status === "cancelled") {
        throw new RequestError(409, "Antrean sudah tidak aktif");
      }

      await client.query(
        `UPDATE queues
         SET checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [current.id]
      );
      await refreshQueueEta(client, current.barber_id, current.queue_date);
      return loadQueueDetails(client, current.id);
    }, "Queue check-in");
    return res.status(200).json({
      success: true,
      message: "Check-in berhasil",
      data: queue,
    });
  } catch (error) {
    return respondError(res, error, "Queue check-in", "Gagal melakukan check-in");
  }
};

module.exports = {
  createQueueForConfirmedBooking,
  refreshQueueEta,
  lockBarberForServing,
  calculateSmartEta,
  getMyQueues,
  getTodayQueues,
  getQueueById,
  callQueue,
  startQueue,
  completeQueue,
  cancelQueue,
  checkInQueue,
  checkInByToken,
};
