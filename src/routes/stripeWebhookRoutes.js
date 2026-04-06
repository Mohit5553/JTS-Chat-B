import express from "express";
import { handleWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// Stripe requires the raw body for signature verification
router.post("/stripe", express.raw({ type: "application/json" }), handleWebhook);

export default router;
