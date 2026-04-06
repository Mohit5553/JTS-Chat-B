import { env } from "../config/env.js";
import { User } from "../models/User.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken";

export async function getUserFromToken(token) {
  if (!token) {
    throw new AppError("You are not logged in! Please log in to get access.", 401);
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw new AppError("Your token has expired! Please log in again.", 401);
    }
    throw new AppError("Invalid token! Please log in again.", 401);
  }

  const user = await User.findById(payload.id).select("-password");
  if (!user) {
    throw new AppError("The user belonging to this token no longer exists.", 401);
  }

  return user;
}

export const requireAuth = asyncHandler(async (req, res, next) => {
  let token = "";

  if (req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies?.jwt) {
    token = req.cookies.jwt;
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return next(new AppError("You are not logged in! Please log in to get access.", 401));
  }
  req.user = await getUserFromToken(token);
  next();
});

export function requireRole(...roles) {
  return (req, res, next) => {
    let allowedRoles = [...roles];
    // If 'client' is allowed, also allow 'manager' (tenant admins)
    if (allowedRoles.includes("client")) {
      allowedRoles.push("manager");
    }

    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
}
