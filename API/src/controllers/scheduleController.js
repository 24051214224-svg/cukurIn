const pool = require("../config/database");
const {
  barberIdSchema,
  scheduleIdSchema,
  createScheduleSchema,
  updateScheduleSchema,
  isValidTimeRange,
} = require("../validators/scheduleValidator");

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

const respondWithDatabaseError = (res, error, operation, message) => {
  if (error instanceof RequestError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "Jadwal bertabrakan dengan jadwal lain",
    });
  }

  console.error(`${operation} error:`, error.message);
  return res.status(500).json({
    success: false,
    message,
  });
};

const lockBarber = async (client, barberId) => {
  const result = await client.query(
    `SELECT b.id,
            b.is_available AS barber_is_available,
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

  return result.rows[0];
};

const ensureBarberCanHaveSchedule = (barber, scheduleIsAvailable) => {
  if (!barber.user_is_active) {
    throw new RequestError(409, "Akun barber tidak aktif");
  }

  if (scheduleIsAvailable && !barber.barber_is_available) {
    throw new RequestError(409, "Barber sedang tidak tersedia");
  }
};

const ensureNoScheduleOverlap = async (
  client,
  barberId,
  schedule,
  excludedScheduleId = null
) => {
  const result = await client.query(
    `SELECT id
     FROM schedules
     WHERE barber_id = $1
       AND day_of_week = $2
       AND start_time < $4::time
       AND end_time > $3::time
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     LIMIT 1`,
    [
      barberId,
      schedule.day_of_week,
      schedule.start_time,
      schedule.end_time,
      excludedScheduleId,
    ]
  );

  if (result.rows.length > 0) {
    throw new RequestError(409, "Jadwal bertabrakan dengan jadwal lain");
  }
};

const getBarberSchedules = async (req, res) => {
  const validation = barberIdSchema.safeParse(req.params.barberId);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `SELECT b.id AS barber_id,
              b.is_available AS barber_is_available,
              s.id AS schedule_id,
              s.day_of_week,
              s.start_time,
              s.end_time,
              s.is_available,
              s.created_at,
              s.updated_at
       FROM barbers b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN schedules s ON s.barber_id = b.id
       WHERE b.id = $1
         AND u.role = 'barber'
         AND u.is_active = TRUE
       ORDER BY s.day_of_week ASC, s.start_time ASC, s.id ASC`,
      [validation.data]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Barber tidak ditemukan",
      });
    }

    const firstRow = result.rows[0];
    const schedules = result.rows
      .filter((row) => row.schedule_id !== null)
      .map((row) => ({
        id: row.schedule_id,
        day_of_week: row.day_of_week,
        start_time: row.start_time,
        end_time: row.end_time,
        is_available: row.is_available,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));

    return res.status(200).json({
      success: true,
      message: "Jadwal barber berhasil diambil",
      data: {
        barber_id: firstRow.barber_id,
        barber_is_available: firstRow.barber_is_available,
        schedules,
      },
    });
  } catch (error) {
    console.error("Get barber schedules error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil jadwal barber",
    });
  }
};

const createBarberSchedule = async (req, res) => {
  const barberValidation = barberIdSchema.safeParse(req.params.barberId);
  if (!barberValidation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: barberValidation.error.issues,
    });
  }

  const validation = createScheduleSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data jadwal tidak valid",
      errors: validation.error.issues,
    });
  }

  const barberId = barberValidation.data;
  const schedule = validation.data;

  try {
    const createdSchedule = await withTransaction(async (client) => {
      const barber = await lockBarber(client, barberId);
      ensureBarberCanHaveSchedule(barber, schedule.is_available);
      await ensureNoScheduleOverlap(client, barberId, schedule);

      const result = await client.query(
        `INSERT INTO schedules (
           barber_id, day_of_week, start_time, end_time, is_available
         )
         VALUES ($1, $2, $3::time, $4::time, $5)
         RETURNING id, barber_id, day_of_week, start_time, end_time,
                   is_available, created_at, updated_at`,
        [
          barberId,
          schedule.day_of_week,
          schedule.start_time,
          schedule.end_time,
          schedule.is_available,
        ]
      );

      return result.rows[0];
    }, "Create barber schedule");

    return res.status(201).json({
      success: true,
      message: "Jadwal barber berhasil ditambahkan",
      data: createdSchedule,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Create barber schedule",
      "Gagal menambahkan jadwal barber"
    );
  }
};

const updateBarberSchedule = async (req, res) => {
  const barberValidation = barberIdSchema.safeParse(req.params.barberId);
  const scheduleIdValidation = scheduleIdSchema.safeParse(
    req.params.scheduleId
  );

  if (!barberValidation.success || !scheduleIdValidation.success) {
    const issues = [
      ...(barberValidation.success ? [] : barberValidation.error.issues),
      ...(scheduleIdValidation.success ? [] : scheduleIdValidation.error.issues),
    ];
    return res.status(400).json({
      success: false,
      message: "ID barber atau jadwal tidak valid",
      errors: issues,
    });
  }

  const validation = updateScheduleSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data jadwal tidak valid",
      errors: validation.error.issues,
    });
  }

  const barberId = barberValidation.data;
  const scheduleId = scheduleIdValidation.data;
  const updates = validation.data;

  try {
    const updatedSchedule = await withTransaction(async (client) => {
      const barber = await lockBarber(client, barberId);
      const currentResult = await client.query(
        `SELECT id, day_of_week, start_time, end_time, is_available
         FROM schedules
         WHERE id = $1 AND barber_id = $2
         FOR UPDATE`,
        [scheduleId, barberId]
      );

      if (currentResult.rows.length === 0) {
        throw new RequestError(404, "Jadwal barber tidak ditemukan");
      }

      const currentSchedule = currentResult.rows[0];
      const schedule = {
        day_of_week: updates.day_of_week ?? currentSchedule.day_of_week,
        start_time: updates.start_time ?? currentSchedule.start_time,
        end_time: updates.end_time ?? currentSchedule.end_time,
        is_available: updates.is_available ?? currentSchedule.is_available,
      };

      if (!isValidTimeRange(schedule.start_time, schedule.end_time)) {
        throw new RequestError(
          400,
          "Jam selesai harus setelah jam mulai pada hari yang sama"
        );
      }

      ensureBarberCanHaveSchedule(barber, schedule.is_available);
      await ensureNoScheduleOverlap(client, barberId, schedule, scheduleId);

      const result = await client.query(
        `UPDATE schedules
         SET day_of_week = $3,
             start_time = $4::time,
             end_time = $5::time,
             is_available = $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND barber_id = $2
         RETURNING id, barber_id, day_of_week, start_time, end_time,
                   is_available, created_at, updated_at`,
        [
          scheduleId,
          barberId,
          schedule.day_of_week,
          schedule.start_time,
          schedule.end_time,
          schedule.is_available,
        ]
      );

      return result.rows[0];
    }, "Update barber schedule");

    return res.status(200).json({
      success: true,
      message: "Jadwal barber berhasil diperbarui",
      data: updatedSchedule,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Update barber schedule",
      "Gagal memperbarui jadwal barber"
    );
  }
};

const deleteBarberSchedule = async (req, res) => {
  const barberValidation = barberIdSchema.safeParse(req.params.barberId);
  const scheduleIdValidation = scheduleIdSchema.safeParse(
    req.params.scheduleId
  );

  if (!barberValidation.success || !scheduleIdValidation.success) {
    const issues = [
      ...(barberValidation.success ? [] : barberValidation.error.issues),
      ...(scheduleIdValidation.success ? [] : scheduleIdValidation.error.issues),
    ];
    return res.status(400).json({
      success: false,
      message: "ID barber atau jadwal tidak valid",
      errors: issues,
    });
  }

  try {
    const barberId = barberValidation.data;
    const scheduleId = scheduleIdValidation.data;
    const deletedSchedule = await withTransaction(async (client) => {
      await lockBarber(client, barberId);
      const result = await client.query(
        `DELETE FROM schedules
         WHERE id = $1 AND barber_id = $2
         RETURNING id`,
        [scheduleId, barberId]
      );

      if (result.rows.length === 0) {
        throw new RequestError(404, "Jadwal barber tidak ditemukan");
      }

      return result.rows[0];
    }, "Delete barber schedule");

    return res.status(200).json({
      success: true,
      message: "Jadwal barber berhasil dihapus",
      data: deletedSchedule,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Delete barber schedule",
      "Gagal menghapus jadwal barber"
    );
  }
};

module.exports = {
  getBarberSchedules,
  createBarberSchedule,
  updateBarberSchedule,
  deleteBarberSchedule,
};
