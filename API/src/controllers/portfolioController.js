const pool = require("../config/database");
const {
  barberPortfolioParamsSchema,
  portfolioParamsSchema,
  portfolioIdParamsSchema,
  portfolioWriteSchema,
} = require("../validators/portfolioValidator");

const getBarberPortfolios = async (req, res) => {
  const validation = barberPortfolioParamsSchema.safeParse(req.params);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const barberResult = await pool.query(
      `SELECT b.id
       FROM barbers b
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND u.role = 'barber' AND u.is_active = TRUE`,
      [validation.data.barberId]
    );
    if (barberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Barber tidak ditemukan",
      });
    }

    const result = await pool.query(
      `SELECT id, barber_id, title, description, image_url, created_at, updated_at
       FROM portfolios
       WHERE barber_id = $1
       ORDER BY created_at DESC, id ASC`,
      [validation.data.barberId]
    );

    return res.status(200).json({
      success: true,
      message: "Daftar portfolio barber berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    console.error("Get barber portfolios error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil daftar portfolio barber",
    });
  }
};

const getBarberPortfolioById = async (req, res) => {
  const validation = portfolioParamsSchema.safeParse(req.params);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID barber atau portfolio tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `SELECT p.id, p.barber_id, p.title, p.description, p.image_url,
              p.created_at, p.updated_at
       FROM portfolios p
       JOIN barbers b ON b.id = p.barber_id
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1
         AND p.id = $2
         AND u.role = 'barber'
         AND u.is_active = TRUE`,
      [validation.data.barberId, validation.data.portfolioId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Portfolio tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Detail portfolio berhasil diambil",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get barber portfolio error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil detail portfolio",
    });
  }
};

const createPortfolio = async (req, res) => {
  const validation = portfolioWriteSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data portfolio tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO portfolios (barber_id, title, description, image_url)
       SELECT b.id, $2, $3, $4
       FROM barbers b
       JOIN users u ON u.id = b.user_id
       WHERE b.user_id = $1
         AND u.role = 'barber'
         AND u.is_active = TRUE
       RETURNING id, barber_id, title, description, image_url, created_at, updated_at`,
      [
        req.user.id,
        validation.data.title,
        validation.data.description ?? null,
        validation.data.image_url,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Profil barber tidak ditemukan",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Portfolio berhasil dibuat",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Create portfolio error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal membuat portfolio",
    });
  }
};

const updatePortfolio = async (req, res) => {
  const idValidation = portfolioIdParamsSchema.safeParse(req.params);
  if (!idValidation.success) {
    return res.status(400).json({
      success: false,
      message: "ID portfolio tidak valid",
      errors: idValidation.error.issues,
    });
  }

  const validation = portfolioWriteSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Data portfolio tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `UPDATE portfolios p
       SET title = $3,
           description = $4,
           image_url = $5,
           updated_at = CURRENT_TIMESTAMP
       FROM barbers b
       JOIN users u ON u.id = b.user_id
       WHERE p.id = $1
         AND p.barber_id = b.id
         AND b.user_id = $2
         AND u.role = 'barber'
         AND u.is_active = TRUE
       RETURNING p.id, p.barber_id, p.title, p.description, p.image_url,
                 p.created_at, p.updated_at`,
      [
        idValidation.data.id,
        req.user.id,
        validation.data.title,
        validation.data.description ?? null,
        validation.data.image_url,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Portfolio tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Portfolio berhasil diperbarui",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update portfolio error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal memperbarui portfolio",
    });
  }
};

const deletePortfolio = async (req, res) => {
  const validation = portfolioIdParamsSchema.safeParse(req.params);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "ID portfolio tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await pool.query(
      `DELETE FROM portfolios p
       USING barbers b
       JOIN users u ON u.id = b.user_id
       WHERE p.id = $1
         AND p.barber_id = b.id
         AND b.user_id = $2
         AND u.role = 'barber'
         AND u.is_active = TRUE
       RETURNING p.id, p.barber_id, p.title, p.description, p.image_url,
                 p.created_at, p.updated_at`,
      [validation.data.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Portfolio tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Portfolio berhasil dihapus",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Delete portfolio error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal menghapus portfolio",
    });
  }
};

module.exports = {
  getBarberPortfolios,
  getBarberPortfolioById,
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
};
