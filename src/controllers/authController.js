import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { createSendToken } from "../utils/jwt.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { normalizeRole } from "../utils/roleUtils.js";
import { buildOtpAuthUri, generateTotpSecret, verifyTotp } from "../services/totpService.js";
import { logAuditEvent } from "../services/auditService.js";
import { buildSubscription, resolveSubscriptionForUser } from "../utils/planUtils.js";

const OWNER_ROLES = ["admin", "client", "manager"];

async function getTenantSubscription(user) {
  if (user.role === "admin" || user.role === "client") {
    return resolveSubscriptionForUser(user);
  }

  if (!user.managerId) {
    return resolveSubscriptionForUser(user);
  }

  const tenant = await User.findById(user.managerId).select("subscription role");
  return resolveSubscriptionForUser(tenant || user);
}

async function serializeUser(user) {
  const subscription = await getTenantSubscription(user);
  return {
    id: user._id,
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    managerId: user.managerId,
    websiteIds: user.websiteIds || [],
    isOnline: user.isOnline,
    isAvailable: user.isAvailable,
    twoFactorEnabled: !!user.twoFactorEnabled,
    subscription
  };
}

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(["admin", "client", "agent"]).optional()
});

export const register = asyncHandler(async (req, res, next) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    return next(new AppError(result.error.issues?.[0]?.message || "Invalid input", 400));
  }

  const { name, email, password } = result.data;
  const requestedRole = result.data.role || "client";
  const role = normalizeRole(requestedRole);

  const existing = await User.findOne({ email });
  if (existing) {
    return next(new AppError("Email already registered", 409));
  }

  let managerId = null;
  if (role === "agent") {
    if (!req.user || !OWNER_ROLES.includes(req.user.role)) {
      return next(new AppError("Only admin or client can create agents", 403));
    }
    managerId = req.user._id;
  }

  if (role === "admin" && req.user?.role !== "admin") {
    return next(new AppError("Only admin can create admin users", 403));
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    role,
    managerId,
    isAvailable: role === "agent",
    ...(role === "client" ? { subscription: buildSubscription("basic", { status: "expired" }) } : {})
  });

  await logAuditEvent({
    actor: req.user || user,
    action: "user.registered",
    entityType: "user",
    entityId: user._id,
    metadata: { createdRole: role },
    ipAddress: req.ip
  });

  return createSendToken(await serializeUser(user), 201, res);
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
  twoFactorCode: z.string().optional()
});

export const login = asyncHandler(async (req, res, next) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return next(new AppError(result.error.issues?.[0]?.message || "Invalid input", 400));
  }

  const { email, password, twoFactorCode } = result.data;
  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return next(new AppError("Invalid credentials", 401));
  }

  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      return res.status(202).json({
        status: "2fa_required",
        twoFactorRequired: true,
        userId: user._id
      });
    }

    if (!verifyTotp({ secret: user.twoFactorSecret, token: twoFactorCode })) {
      return next(new AppError("Invalid two-factor authentication code", 401));
    }
  }

  user.lastActiveAt = new Date();
  await user.save();

  await logAuditEvent({
    actor: user,
    action: "auth.login",
    entityType: "user",
    entityId: user._id,
    ipAddress: req.ip
  });

  return createSendToken(await serializeUser(user), 200, res);
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    status: "success",
    user: await serializeUser(req.user)
  });
});

export const setupTwoFactor = asyncHandler(async (req, res) => {
  const secret = generateTotpSecret();
  req.user.twoFactorTemp = {
    secret,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  };
  await req.user.save();

  res.json({
    secret,
    otpAuthUrl: buildOtpAuthUri({
      secret,
      email: req.user.email,
      issuer: "Chat Support"
    }),
    expiresAt: req.user.twoFactorTemp.expiresAt
  });
});

export const verifyTwoFactorSetup = asyncHandler(async (req, res, next) => {
  const code = String(req.body.code || "");
  const tempSecret = req.user.twoFactorTemp?.secret;
  const expiresAt = req.user.twoFactorTemp?.expiresAt;

  if (!tempSecret || !expiresAt || expiresAt < new Date()) {
    return next(new AppError("Two-factor setup session expired. Start setup again.", 400));
  }

  if (!verifyTotp({ secret: tempSecret, token: code })) {
    return next(new AppError("Invalid authentication code", 400));
  }

  req.user.twoFactorEnabled = true;
  req.user.twoFactorSecret = tempSecret;
  req.user.twoFactorTemp = { secret: null, expiresAt: null };
  await req.user.save();

  await logAuditEvent({
    actor: req.user,
    action: "auth.2fa.enabled",
    entityType: "user",
    entityId: req.user._id,
    ipAddress: req.ip
  });

  res.json({ success: true, twoFactorEnabled: true });
});

export const disableTwoFactor = asyncHandler(async (req, res, next) => {
  const password = String(req.body.password || "");
  const code = String(req.body.code || "");

  if (!password) return next(new AppError("Password is required", 400));

  const freshUser = await User.findById(req.user._id);
  if (!freshUser || !(await bcrypt.compare(password, freshUser.password))) {
    return next(new AppError("Invalid password", 401));
  }

  if (freshUser.twoFactorEnabled && !verifyTotp({ secret: freshUser.twoFactorSecret, token: code })) {
    return next(new AppError("Invalid authentication code", 401));
  }

  freshUser.twoFactorEnabled = false;
  freshUser.twoFactorSecret = null;
  freshUser.twoFactorTemp = { secret: null, expiresAt: null };
  await freshUser.save();

  await logAuditEvent({
    actor: freshUser,
    action: "auth.2fa.disabled",
    entityType: "user",
    entityId: freshUser._id,
    ipAddress: req.ip
  });

  res.json({ success: true, twoFactorEnabled: false });
});

export const refresh = asyncHandler(async (req, res) => {
  await logAuditEvent({
    actor: req.user,
    action: "auth.token.refreshed",
    entityType: "user",
    entityId: req.user._id,
    ipAddress: req.ip
  });

  return createSendToken(await serializeUser(req.user), 200, res);
});
