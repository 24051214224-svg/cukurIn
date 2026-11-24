const express = require("express");
const {
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
} = require("../controllers/portfolioController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/", authenticateToken, authorizeRoles("barber"), createPortfolio);
router.put("/:id", authenticateToken, authorizeRoles("barber"), updatePortfolio);
router.delete("/:id", authenticateToken, authorizeRoles("barber"), deletePortfolio);

module.exports = router;
