const express = require("express");
const {
  getBookings,
  getBookingById,
  createBooking,
  cancelBooking,
  updateBookingStatus,
} = require("../controllers/bookingController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.use(authenticateToken);

router.get("/", authorizeRoles("customer", "barber", "admin"), getBookings);
router.post("/", authorizeRoles("customer"), createBooking);
router.get(
  "/:id",
  authorizeRoles("customer", "barber", "admin"),
  getBookingById
);
router.patch("/:id/cancel", authorizeRoles("customer"), cancelBooking);
router.patch(
  "/:id/status",
  authorizeRoles("barber", "admin"),
  updateBookingStatus
);

module.exports = router;
