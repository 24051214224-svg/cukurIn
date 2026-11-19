
const pool = require("../config/database");

// Menampilkan semua layanan aktif
const getServices = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, service_name, description, price, duration_minutes
       FROM services
       WHERE is_active = TRUE
       ORDER BY service_name ASC`
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get services error:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil layanan",
    });
  }
};

// Detail layanan
const getServiceById = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, service_name, description, price, duration_minutes
       FROM services
       WHERE id = $1 AND is_active = TRUE`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Layanan tidak ditemukan",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get service error:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil detail layanan",
    });
  }
};

// Tambah layanan
const createService = async (req, res) => {
  try {
    const { service_name, description, price, duration_minutes } = req.body;

    if (
      !service_name ||
      !Number.isFinite(Number(price)) ||
      Number(price) < 0 ||
      !Number.isInteger(Number(duration_minutes)) ||
      Number(duration_minutes) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Data layanan tidak valid",
      });
    }

    const result = await pool.query(
      `INSERT INTO services (service_name, description, price, duration_minutes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        service_name.trim(),
        description || null,
        Number(price),
        Number(duration_minutes),
      ]
    );

    res.status(201).json({
      success: true,
      message: "Layanan berhasil ditambahkan",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Create service error:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal menambahkan layanan",
    });
  }
};

// Ubah layanan
const updateService = async (req, res) => {
  try {
    const { service_name, description, price, duration_minutes } = req.body;

    if (
      !service_name?.trim() ||
      !Number.isFinite(Number(price)) ||
      Number(price) < 0 ||
      !Number.isInteger(Number(duration_minutes)) ||
      Number(duration_minutes) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Data layanan tidak valid",
      });
    }

    const result = await pool.query(
      `UPDATE services
       SET service_name = $1,
           description = $2,
           price = $3,
           duration_minutes = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [
        service_name.trim(),
        description || null,
        Number(price),
        Number(duration_minutes),
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Layanan tidak ditemukan",
      });
    }

    res.json({
      success: true,
      message: "Layanan berhasil diperbarui",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update service error:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal memperbarui layanan",
    });
  }
};

// Hapus layanan (soft delete)
const deleteService = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE services
       SET is_active = FALSE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = TRUE
       RETURNING id`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Layanan tidak ditemukan atau sudah dinonaktifkan",
      });
    }

    res.json({
      success: true,
      message: "Layanan berhasil dinonaktifkan",
    });
  } catch (error) {
    console.error("Delete service error:", error.message);
    res.status(500).json({
      success: false,
      message: "Gagal menonaktifkan layanan",
    });
  }
};

module.exports = {
  getServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
};
