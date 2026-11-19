const express = require("express");
const {
  createReview,
  getBarberReviews,
  getMyReviews,
  getReviewById,
} = require("../controllers/reviewController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/barber/:barberId", getBarberReviews);
router.get("/my", authenticateToken, authorizeRoles("customer"), getMyReviews);
router.post("/", authenticateToken, authorizeRoles("customer"), createReview);
router.get("/:id", authenticateToken, authorizeRoles("customer", "barber", "admin"), getReviewById);

module.exports = router;
