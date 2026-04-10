import { Router } from "express";
import { createWebsite, listWebsites, updateWebsite } from "../controllers/websiteController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireRole("admin", "client", "manager", "sales"));
router.get("/", listWebsites);
router.post("/", createWebsite);
router.patch("/:id", updateWebsite);

export default router;
