import { Router } from "express";
import { listCannedResponses, createCannedResponse, deleteCannedResponse } from "../controllers/cannedResponseController.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, listCannedResponses);
router.post("/", requireAuth, createCannedResponse);
router.delete("/:id", requireAuth, deleteCannedResponse);

export default router;
