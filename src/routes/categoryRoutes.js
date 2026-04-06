import express from "express";
import { getCategories, createCategory, updateCategory, deleteCategory } from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";

const router = express.Router();

router.use(requireAuth, attachTenantSubscription, requirePlanFeature("tickets"));

router.get("/", requireRole("admin", "client", "agent", "sales"), getCategories);
router.post("/", requireRole("client", "admin", "manager"), createCategory);
router.patch("/:id", requireRole("client", "admin", "manager"), updateCategory);
router.delete("/:id", requireRole("client", "admin", "manager"), deleteCategory);

export default router;
