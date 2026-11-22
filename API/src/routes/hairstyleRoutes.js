const express = require("express");
const { getRecommendations } = require("../controllers/hairstyleController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.get(
  "/recommendations",
  authenticateToken,
  authorizeRoles("customer"),
  getRecommendations
);

module.exports = router;
