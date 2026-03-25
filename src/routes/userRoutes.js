import { Router } from "express";
import { createAgent, listAgents, updateAvailability, listClients, createClient, updateProfile, updateAgent, deleteAgent } from "../controllers/userController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/agents", requireAuth, listAgents);
router.post("/agents", requireAuth, requireRole("admin", "client"), createAgent);
router.patch("/agents/:id", requireAuth, requireRole("admin", "client"), updateAgent);
router.delete("/agents/:id", requireAuth, requireRole("admin", "client"), deleteAgent);
router.get("/clients", requireAuth, requireRole("admin"), listClients);
router.post("/clients", requireAuth, requireRole("admin"), createClient);
router.patch("/availability", requireAuth, requireRole("agent", "client", "admin"), updateAvailability);
router.patch("/profile", requireAuth, updateProfile);

export default router;
