import crypto from "crypto";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { sendEmail } from "../services/emailService.js";
import { passwordResetTemplate } from "../utils/emailTemplates.js";
import { logAuditEvent } from "../services/auditService.js";

// POST /api/auth/forgot-password
export const forgotPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;
  if (!email) return next(new AppError("Email is required", 400));

  const user = await User.findOne({ email: email.toLowerCase().trim() });

  // Always respond with same message (security: don't leak if email exists)
  const safeResponse = () =>
    res.json({
      status: "success",
      message: "If an account with that email exists, a password reset link has been sent."
    });

  if (!user) return safeResponse();

  // Generate secure random token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

  user.resetPasswordToken = hashedToken;
  user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await user.save();

  const resetUrl = `${env.clientUrl}/reset-password/${rawToken}`;
  const { html, subject } = passwordResetTemplate({ name: user.name, resetUrl });

  await sendEmail({ to: user.email, subject, html });
  await logAuditEvent({
    actor: user,
    action: "auth.password_reset_requested",
    entityType: "user",
    entityId: user._id,
    ipAddress: req.ip
  });

  return safeResponse();
});

// POST /api/auth/reset-password/:token
export const resetPassword = asyncHandler(async (req, res, next) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;

  if (!password) return next(new AppError("New password is required", 400));
  if (password.length < 6) return next(new AppError("Password must be at least 6 characters", 400));
  if (confirmPassword && password !== confirmPassword) {
    return next(new AppError("Passwords do not match", 400));
  }

  // Hash the raw token to compare with stored hash
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: new Date() } // not expired
  });

  if (!user) {
    return next(new AppError("Password reset link is invalid or has expired. Please request a new one.", 400));
  }

  user.password = await bcrypt.hash(password, 12);
  user.resetPasswordToken = null;
  user.resetPasswordExpires = null;
  await user.save();

  await logAuditEvent({
    actor: user,
    action: "auth.password_reset_completed",
    entityType: "user",
    entityId: user._id,
    ipAddress: req.ip
  });

  res.json({
    status: "success",
    message: "Password has been reset successfully. You can now log in with your new password."
  });
});
