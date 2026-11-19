
const express = require("express");
const router = express.Router();

const {
  getServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
} = require("../controllers/serviceController");

const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/authMiddleware");

router.get("/", getServices);
router.get("/:id", getServiceById);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("admin"),
  createService
);

router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  updateService
);

router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("admin"),
  deleteService
);

module.exports = router;
