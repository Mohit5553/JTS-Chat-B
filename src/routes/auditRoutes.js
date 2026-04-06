import { Router } from "express";
import { listAuditLogs } from "../controllers/auditController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";

const router = Router();

router.get("/", requireAuth, requireRole("admin", "client"), attachTenantSubscription, requirePlanFeature("security"), listAuditLogs);

export default router;
