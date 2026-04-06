import { Router } from "express";
import { listWebhookDeliveries } from "../controllers/webhookController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/deliveries", requireAuth, requireRole("admin", "client"), listWebhookDeliveries);

export default router;
