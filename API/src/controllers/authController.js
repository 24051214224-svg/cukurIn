
const pool = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  registerSchema,
  loginSchema,
} = require("../validators/authValidator");

const register = async (req, res) => {
  try {
    const validation = registerSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Data registrasi tidak valid",
        errors: validation.error.issues,
      });
    }

    const { full_name, email, phone_number, password } = validation.data;

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1 OR phone_number = $2",
      [email, phone_number]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email atau nomor HP sudah terdaftar",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, phone_number, password_hash, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, full_name, email, phone_number, role, created_at`,
      [full_name, email, phone_number, passwordHash]
    );

    return res.status(201).json({
      success: true,
      message: "Registrasi berhasil",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Register error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
};

const login = async (req, res) => {
  try {
    const validation = loginSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: "Data login tidak valid",
        errors: validation.error.issues,
      });
    }

    const { email, password } = validation.data;

    const result = await pool.query(
      `SELECT id, full_name, email, phone_number, password_hash, role, is_active
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Email atau password salah",
      });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "Akun tidak aktif",
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Email atau password salah",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
    );

    return res.status(200).json({
      success: true,
      message: "Login berhasil",
      data: {
        user: {
          id: user.id,
          full_name: user.full_name,
          email: user.email,
          phone_number: user.phone_number,
          role: user.role,
        },
        token,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
};
 
const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, phone_number, role, profile_photo_url, created_at
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Pengguna tidak ditemukan",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profil berhasil diambil",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Get profile error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
    });
  }
};

module.exports = { register, login, getMe };
