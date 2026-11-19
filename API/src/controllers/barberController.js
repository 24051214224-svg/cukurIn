const bcrypt = require("bcryptjs");
const pool = require("../config/database");
const {
  barberIdSchema,
  listBarbersQuerySchema,
  createBarberSchema,
  updateBarberSchema,
} = require("../validators/barberValidator");

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const publicBarberSelect = `SELECT b.id,
                                   u.full_name,
                                   u.profile_photo_url,
                                   b.bio,
                                   b.experience_years,
                                   b.is_available,
                                   COALESCE(r.average_rating, 0)::numeric(3, 2) AS average_rating,
                                   COALESCE(r.review_count, 0)::integer AS review_count`;

const barberJoins = `FROM barbers b
                     JOIN users u ON u.id = b.user_id
                     LEFT JOIN (
                       SELECT barber_id,
                              AVG(rating)::numeric(3, 2) AS average_rating,
                              COUNT(*) AS review_count
                       FROM reviews
                       GROUP BY barber_id
                     ) r ON r.barber_id = b.id`;

const adminBarberSelect = `SELECT b.id,
                                  u.full_name,
                                  u.email,
                                  u.phone_number,
                                  u.profile_photo_url,
                                  u.is_active,
                                  b.bio,
                                  b.experience_years,
                                  b.is_available,
                                  COALESCE(r.average_rating, 0)::numeric(3, 2) AS average_rating,
                                  COALESCE(r.review_count, 0)::integer AS review_count
                           FROM barbers b
                           JOIN users u ON u.id = b.user_id
                           LEFT JOIN (
                             SELECT barber_id,
                                    AVG(rating)::numeric(3, 2) AS average_rating,
                                    COUNT(*) AS review_count
                             FROM reviews
                             GROUP BY barber_id
                           ) r ON r.barber_id = b.id`;

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
      message: "Email atau nomor HP sudah digunakan",
    });
  }

  console.error(`${operation} error:`, error.message);
  return res.status(500).json({
    success: false,
    message,
  });
};

const findBarberForAdmin = async (client, barberId) => {
  const result = await client.query(
    `SELECT b.id, b.user_id
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

const getAdminBarberProfile = async (client, barberId) => {
  const result = await client.query(
    `SELECT b.id,
            u.full_name,
            u.email,
            u.phone_number,
            u.profile_photo_url,
            u.is_active,
            b.bio,
            b.experience_years,
            b.is_available
     FROM barbers b
     JOIN users u ON u.id = b.user_id
     WHERE b.id = $1`,
    [barberId]
  );

  return result.rows[0];
};

const getBarbers = async (req, res) => {
  const validation = listBarbersQuerySchema.safeParse(req.query);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Parameter pencarian barber tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `${publicBarberSelect},
              COALESCE(p.portfolio_count, 0)::integer AS portfolio_count
       ${barberJoins}
       LEFT JOIN (
         SELECT barber_id, COUNT(*) AS portfolio_count
         FROM portfolios
         GROUP BY barber_id
       ) p ON p.barber_id = b.id
       WHERE u.is_active = TRUE
         AND u.role = 'barber'
         AND ($1::boolean IS NULL OR b.is_available = $1)
       ORDER BY u.full_name ASC, b.id ASC`,
      [validation.data.is_available ?? null]
    );

    return res.status(200).json({
      success: true,
      message: "Daftar barber berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    console.error("Get barbers error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar barber",
    });
  }
};

const getBarbersForAdmin = async (req, res) => {
  try {
    const result = await pool.query(
      `${adminBarberSelect}
       ORDER BY u.full_name ASC, b.id ASC`
    );

    return res.status(200).json({
      success: true,
      message: "Daftar barber berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    console.error("Get admin barbers error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar barber",
    });
  }
};

const getBarberById = async (req, res) => {
  const validation = barberIdSchema.safeParse(req.params.id);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const barberResult = await pool.query(
      `${publicBarberSelect}
       ${barberJoins}
       WHERE b.id = $1
         AND u.is_active = TRUE
         AND u.role = 'barber'`,
      [validation.data]
    );

    if (barberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Barber tidak ditemukan",
      });
    }

    const portfolioResult = await pool.query(
      `SELECT id, title, description, image_url, created_at
       FROM portfolios
       WHERE barber_id = $1
       ORDER BY created_at DESC, id ASC`,
      [validation.data]
    );

    return res.status(200).json({
      success: true,
      message: "Profil barber berhasil diambil",
      data: {
        ...barberResult.rows[0],
        portfolios: portfolioResult.rows,
      },
    });
  } catch (error) {
    console.error("Get barber error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil detail barber",
    });
  }
};

const createBarber = async (req, res) => {
  const validation = createBarberSchema.safeParse(req.body);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data barber tidak valid",
      errors: validation.error.issues,
    });
  }

  const barber = validation.data;

  try {
    const passwordHash = await bcrypt.hash(barber.password, 12);
    const createdBarber = await withTransaction(async (client) => {
      const userResult = await client.query(
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role, profile_photo_url
         )
         VALUES ($1, $2, $3, $4, 'barber', $5)
         RETURNING id`,
        [
          barber.full_name,
          barber.email,
          barber.phone_number,
          passwordHash,
          barber.profile_photo_url ?? null,
        ]
      );
      const userId = userResult.rows[0].id;

      const barberResult = await client.query(
        `INSERT INTO barbers (user_id, bio, experience_years, is_available)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          userId,
          barber.bio ?? null,
          barber.experience_years,
          barber.is_available,
        ]
      );

      return getAdminBarberProfile(client, barberResult.rows[0].id);
    }, "Create barber");

    return res.status(201).json({
      success: true,
      message: "Barber berhasil ditambahkan",
      data: createdBarber,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Create barber",
      "Gagal menambahkan barber"
    );
  }
};

const updateBarber = async (req, res) => {
  const idValidation = barberIdSchema.safeParse(req.params.id);
  if (!idValidation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: idValidation.error.issues,
    });
  }

  const validation = updateBarberSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data barber tidak valid",
      errors: validation.error.issues,
    });
  }

  const barberId = idValidation.data;
  const updates = validation.data;

  try {
    const passwordHash = updates.password
      ? await bcrypt.hash(updates.password, 12)
      : null;

    const updatedBarber = await withTransaction(async (client) => {
      const barber = await findBarberForAdmin(client, barberId);

      await client.query(
        `UPDATE users
         SET full_name = COALESCE($2, full_name),
             email = COALESCE($3, email),
             phone_number = COALESCE($4, phone_number),
             password_hash = COALESCE($5, password_hash),
             profile_photo_url = CASE WHEN $6 THEN $7 ELSE profile_photo_url END,
             is_active = COALESCE($8, is_active),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          barber.user_id,
          updates.full_name ?? null,
          updates.email ?? null,
          updates.phone_number ?? null,
          passwordHash,
          Object.prototype.hasOwnProperty.call(updates, "profile_photo_url"),
          updates.profile_photo_url ?? null,
          updates.is_active ?? null,
        ]
      );

      await client.query(
        `UPDATE barbers
         SET bio = CASE WHEN $2 THEN $3 ELSE bio END,
             experience_years = COALESCE($4, experience_years),
             is_available = CASE
               WHEN $6 IS FALSE THEN FALSE
               WHEN $5 IS NOT NULL THEN $5
               ELSE is_available
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [
          barberId,
          Object.prototype.hasOwnProperty.call(updates, "bio"),
          updates.bio ?? null,
          updates.experience_years ?? null,
          updates.is_available ?? null,
          updates.is_active ?? null,
        ]
      );

      return getAdminBarberProfile(client, barberId);
    }, "Update barber");

    return res.status(200).json({
      success: true,
      message: "Barber berhasil diperbarui",
      data: updatedBarber,
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Update barber",
      "Gagal memperbarui barber"
    );
  }
};

const deactivateBarber = async (req, res) => {
  const validation = barberIdSchema.safeParse(req.params.id);

  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const barberId = validation.data;
    await withTransaction(async (client) => {
      const barber = await findBarberForAdmin(client, barberId);

      await client.query(
        `UPDATE users
         SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [barber.user_id]
      );
      await client.query(
        `UPDATE barbers
         SET is_available = FALSE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [barberId]
      );
    }, "Deactivate barber");

    return res.status(200).json({
      success: true,
      message: "Barber berhasil dinonaktifkan",
      data: { id: barberId, is_active: false, is_available: false },
    });
  } catch (error) {
    return respondWithDatabaseError(
      res,
      error,
      "Deactivate barber",
      "Gagal menonaktifkan barber"
    );
  }
};

module.exports = {
  getBarbers,
  getBarbersForAdmin,
  getBarberById,
  createBarber,
  updateBarber,
  deactivateBarber,
};
