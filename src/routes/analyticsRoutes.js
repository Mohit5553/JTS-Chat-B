import { Router } from "express";
import { getManagerAnalytics, exportAnalyticsCSV } from "../controllers/analyticsController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, requireRole("admin", "client"), getManagerAnalytics);
router.get("/export/csv", requireAuth, requireRole("admin", "client"), exportAnalyticsCSV);

export default router;
