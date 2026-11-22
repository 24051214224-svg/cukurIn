const express = require("express");
const {
  getLoyaltyBalance,
  getLoyaltyHistory,
  redeemLoyaltyPoints,
} = require("../controllers/loyaltyController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.use(authenticateToken, authorizeRoles("customer"));

router.get("/balance", getLoyaltyBalance);
router.get("/history", getLoyaltyHistory);
router.post("/redeem", redeemLoyaltyPoints);

module.exports = router;
