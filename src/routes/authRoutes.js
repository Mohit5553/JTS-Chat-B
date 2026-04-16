import { Router } from "express";
import {
  disableTwoFactor,
  login,
  me,
  refresh,
  register,
  setupTwoFactor,
  verifyTwoFactorSetup
} from "../controllers/authController.js";
import { forgotPassword, resetPassword } from "../controllers/passwordResetController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh", requireAuth, refresh);
router.get("/me", requireAuth, me);
router.post("/agents/register", requireAuth, requireRole("admin", "client"), register);
router.post("/2fa/setup", requireAuth, setupTwoFactor);
router.post("/2fa/verify", requireAuth, verifyTwoFactorSetup);
router.post("/2fa/disable", requireAuth, disableTwoFactor);

// Forgot / Reset Password
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

export default router;

