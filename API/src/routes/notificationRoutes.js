const express = require("express");
const {
  getNotifications,
  markNotificationAsRead,
} = require("../controllers/notificationController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.use(
  authenticateToken,
  authorizeRoles("customer", "barber", "admin")
);

router.get("/", getNotifications);
router.patch("/:id/read", markNotificationAsRead);

module.exports = router;
