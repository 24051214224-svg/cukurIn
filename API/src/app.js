
const express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./docs/swagger");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CukurIn API is running",
    version: "1.0.0",
  });
});

// Cek status API dan database
app.get("/api/health", async (req, res) => {
  try {
    const pool = require("./config/database");
    const result = await pool.query("SELECT NOW() AS server_time");

    res.status(200).json({
      success: true,
      message: "API dan database terhubung",
      database: "connected",
      serverTime: result.rows[0].server_time,
    });
  } catch (error) {
    console.error("Health check error:", error.message);

    res.status(503).json({
      success: false,
      message: "Database belum terhubung",
      database: "disconnected",
    });
  }
});
app.use("/api/auth", require("./routes/authRoutes"));

app.use("/api/services", require("./routes/serviceRoutes"));

app.use("/api/barbers", require("./routes/barberRoutes"));

app.use("/api/bookings", require("./routes/bookingRoutes"));

app.use("/api/queues", require("./routes/queueRoutes"));

app.use("/api/reviews", require("./routes/reviewRoutes"));

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint tidak ditemukan",
  });
});

module.exports = app;

