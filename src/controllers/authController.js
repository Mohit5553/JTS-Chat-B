import bcrypt from "bcryptjs";
import { z } from "zod";
import { User } from "../models/User.js";
import { signToken, createSendToken } from "../utils/jwt.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";

const OWNER_ROLES = ["admin", "client", "manager"];

function normalizeRole(role) {
  return role === "manager" ? "admin" : role;
}

function serializeUser(user) {
  return {
    id: user._id,
    _id: user._id,
    name: user.name,
    email: user.email,
    role: normalizeRole(user.role),
    managerId: user.managerId,
    isOnline: user.isOnline,
    isAvailable: user.isAvailable
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
    return next(new AppError(result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || "Invalid input", 400));
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

  const hashedPassword = await bcrypt.hash(password, 12); // Increased cost for professional security
  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    role,
    managerId,
    isAvailable: role === "agent"
  });

  return createSendToken(user, 201, res);
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required")
});

export const login = asyncHandler(async (req, res, next) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) {
    return next(new AppError(result.error.errors[0].message, 400));
  }

  const { email, password } = result.data;
  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return next(new AppError("Invalid credentials", 401));
  }

  if (user.role === "manager") {
    user.role = "admin";
  }

  user.lastActiveAt = new Date();
  await user.save();

  return createSendToken(user, 200, res);
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    status: "success",
    user: serializeUser(req.user)
  });
});

