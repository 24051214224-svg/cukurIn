const express = require("express");
const {
  getMyQueues,
  getQueueById,
  callQueue,
  startQueue,
  completeQueue,
  cancelQueue,
  checkInQueue,
  checkInByToken,
} = require("../controllers/queueController");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.use(authenticateToken);

router.get("/my", authorizeRoles("customer"), getMyQueues);
router.post("/check-in", authorizeRoles("customer"), checkInByToken);
router.patch("/:id/check-in", authorizeRoles("customer"), checkInQueue);
router.get("/:id", authorizeRoles("customer", "barber", "admin"), getQueueById);
router.patch("/:id/call", authorizeRoles("barber", "admin"), callQueue);
router.patch("/:id/start", authorizeRoles("barber", "admin"), startQueue);
router.patch("/:id/complete", authorizeRoles("barber", "admin"), completeQueue);
router.patch("/:id/cancel", authorizeRoles("customer", "barber", "admin"), cancelQueue);

module.exports = router;
