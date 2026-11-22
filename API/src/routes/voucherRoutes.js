const express = require("express");
const {
  getVouchers,
  getVoucherById,
  createVoucher,
  updateVoucher,
  validateVoucher,
} = require("../controllers/voucherController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.use(authenticateToken);

router.post("/validate", authorizeRoles("customer"), validateVoucher);
router.get("/", authorizeRoles("admin"), getVouchers);
router.post("/", authorizeRoles("admin"), createVoucher);
router.get("/:id", authorizeRoles("admin"), getVoucherById);
router.patch("/:id", authorizeRoles("admin"), updateVoucher);

module.exports = router;
