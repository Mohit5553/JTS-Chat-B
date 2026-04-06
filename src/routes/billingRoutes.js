import express from "express";
import { 
  createCheckoutSession, 
  createPortalSession, 
  getSubscriptionStatus, 
  adminGetAllSubscriptions,
  executeMockCheckout 
} from "../controllers/billingController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/status", getSubscriptionStatus);
router.get("/admin/all", adminGetAllSubscriptions);
router.post("/checkout", createCheckoutSession);
router.post("/mock-checkout", executeMockCheckout);
router.post("/portal", createPortalSession);

export default router;
