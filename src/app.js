import express from "express";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/authRoutes.js";
import websiteRoutes from "./routes/websiteRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import widgetRoutes from "./routes/widgetRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import ticketRoutes from "./routes/ticketRoutes.js";
import cannedResponseRoutes from "./routes/cannedResponseRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import departmentRoutes from "./routes/departmentRoutes.js";
import crmRoutes from "./routes/crmRoutes.js";
import auditRoutes from "./routes/auditRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import stripeWebhookRoutes from "./routes/stripeWebhookRoutes.js";
import billingRoutes from "./routes/billingRoutes.js";
import trackingRoutes from "./routes/trackingRoutes.js";
import { env } from "./config/env.js";

import errorMiddleware from "./middleware/errorMiddleware.js";
import AppError from "./utils/AppError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();
  const publicCorsPaths = [
    "/chat-widget.js",
    "/api/widget/",
    "/api/tickets/submit",
    "/api/tickets/public/",
    "/api/tracking/",
    "/uploads/"
  ];

  app.use((req, res, next) => {
    req.url = req.url.replace(/\/{2,}/g, "/");
    next();
  });

  const allowedOrigins = new Set(env.allowedOrigins);
  const corsOptionsDelegate = (req, callback) => {
    const origin = req.headers.origin;
    const isPublicPath = publicCorsPaths.some((path) => req.path === path || req.path.startsWith(path));

    if (!origin) {
      return callback(null, { origin: true, credentials: true });
    }

    if (isPublicPath) {
      return callback(null, { origin: true, credentials: false });
    }

    if (allowedOrigins.has(origin)) {
      return callback(null, { origin: true, credentials: true });
    }

    return callback(null, { origin: false });
  };

  app.use(cors(corsOptionsDelegate));
  app.options("*", cors(corsOptionsDelegate));

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
  }));

  if (process.env.NODE_ENV === "development") {
    app.use(morgan("dev"));
  }

  const authLimiter = rateLimit({
    max: 15,
    windowMs: 15 * 60 * 1000,
    message: { status: "error", message: "Too many login attempts. Please try again in 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false
  });
  const generalLimiter = rateLimit({
    max: 1000,
    windowMs: 60 * 60 * 1000,
    message: { status: "error", message: "Too many requests from this IP, please try again in an hour!" }
  });
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/forgot-password", authLimiter);
  app.use("/api/auth/reset-password", authLimiter);
  app.use("/api", generalLimiter);

  // STRIPE WEBHOOK NEEDS TO BE REGISTERED BEFORE EXPRESS.JSON
  app.use("/api/stripe-webhooks", stripeWebhookRoutes);

  app.use(express.json({ limit: "50kb" }));
  app.use(cookieParser());

  app.use(express.static(path.join(__dirname, "public")));
  app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

  app.get("/", (_, res) => res.json({ status: "success", message: "JTS Chat Backend is Live", version: "1.0.0" }));
  app.get("/health", (_, res) => res.json({ ok: true, timestamp: new Date() }));

  app.use(widgetRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/websites", websiteRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/tickets", ticketRoutes);
  app.use("/api/canned-responses", cannedResponseRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/categories", categoryRoutes);
  app.use("/api/departments", departmentRoutes);
  app.use("/api/crm", crmRoutes);
  app.use("/api/audit-logs", auditRoutes);
  app.use("/api/webhooks", webhookRoutes);
  app.use("/api/billing", billingRoutes);
  app.use("/api/tracking", trackingRoutes);

  app.all("*", (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
  });

  app.use(errorMiddleware);
  return app;
}
