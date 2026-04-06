import { Router } from "express";
import { getManagerAnalytics, exportAnalyticsCSV } from "../controllers/analyticsController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";

const router = Router();

router.get("/", requireAuth, requireRole("admin", "client", "manager"), getManagerAnalytics);
router.get("/export/csv", requireAuth, requireRole("admin", "client", "manager"), attachTenantSubscription, requirePlanFeature("reports"), exportAnalyticsCSV);

export default router;
