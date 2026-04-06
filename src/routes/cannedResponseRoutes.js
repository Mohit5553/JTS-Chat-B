import { Router } from "express";
import { listCannedResponses, createCannedResponse, deleteCannedResponse } from "../controllers/cannedResponseController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, requireRole("admin", "client", "manager", "agent", "sales", "user"), listCannedResponses);
router.post("/", requireAuth, requireRole("admin", "client", "manager", "agent"), createCannedResponse);
router.delete("/:id", requireAuth, requireRole("admin", "client", "manager", "agent"), deleteCannedResponse);

export default router;
