import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email },
    env.jwtSecret,
    { expiresIn: "1h" } // Standardized for professional use
  );
}

export const createSendToken = (user, statusCode, res) => {
  const token = signToken(user);

  const cookieOptions = {
    expires: new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    ),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  };

  res.cookie("jwt", token, cookieOptions);

  // Remove password from output if exists
  if (user.password) user.password = undefined;

  res.status(statusCode).json({
    status: "success",
    token,
    user
  });
};
