const express = require("express");
const {
  getBarbers,
  getBarbersForAdmin,
  getBarberById,
  createBarber,
  updateBarber,
  deactivateBarber,
} = require("../controllers/barberController");
const {
  getBarberSchedules,
  createBarberSchedule,
  updateBarberSchedule,
  deleteBarberSchedule,
} = require("../controllers/scheduleController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");
const { getTodayQueues } = require("../controllers/queueController");

const router = express.Router();

router.get("/", getBarbers);
router.get("/:barberId/schedules", getBarberSchedules);
router.get(
  "/:barberId/queues/today",
  authenticateToken,
  authorizeRoles("barber", "admin"),
  getTodayQueues
);
router.post(
  "/:barberId/schedules",
  authenticateToken,
  authorizeRoles("admin"),
  createBarberSchedule
);
router.patch(
  "/:barberId/schedules/:scheduleId",
  authenticateToken,
  authorizeRoles("admin"),
  updateBarberSchedule
);
router.delete(
  "/:barberId/schedules/:scheduleId",
  authenticateToken,
  authorizeRoles("admin"),
  deleteBarberSchedule
);
router.get(
  "/admin",
  authenticateToken,
  authorizeRoles("admin"),
  getBarbersForAdmin
);
router.post(
  "/",
  authenticateToken,
  authorizeRoles("admin"),
  createBarber
);
router.get("/:id", getBarberById);
router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  updateBarber
);
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  deactivateBarber
);

module.exports = router;
