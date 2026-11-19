
require("dotenv").config();

const app = require("./app");
const pool = require("./config/database");

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await pool.query("SELECT 1");

    console.log("Database PostgreSQL berhasil terhubung.");

    app.listen(PORT, () => {
      console.log(`CukurIn API berjalan di http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Gagal menghubungkan database:", error.message);
    process.exit(1);
  }
};

startServer();
