import express from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { createDepartment, listDepartments, toggleDepartment, updateDepartment } from "../controllers/departmentController.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";

const router = express.Router();

router.use(requireAuth, attachTenantSubscription, requirePlanFeature("tickets"));

router.get("/", requireRole("admin", "client", "manager"), listDepartments);
router.post("/", requireRole("admin", "client", "manager"), createDepartment);
router.patch("/:id", requireRole("admin", "client", "manager"), updateDepartment);
router.patch("/:id/toggle", requireRole("admin", "client", "manager"), toggleDepartment);

export default router;
