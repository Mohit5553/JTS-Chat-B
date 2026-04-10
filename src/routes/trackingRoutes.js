import { Router } from "express";
import { logPageView } from "../controllers/trackingController.js";

const router = Router();

// This is a public endpoint used by the website tracking snippet
router.post("/pageview", logPageView);

export default router;
