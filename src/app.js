// import express from "express";
// import cors from "cors";
// import morgan from "morgan";
// import helmet from "helmet";
// import cookieParser from "cookie-parser";
// import rateLimit from "express-rate-limit";
// import path from "path";
// import { fileURLToPath } from "url";

// import authRoutes from "./routes/authRoutes.js";
// import websiteRoutes from "./routes/websiteRoutes.js";
// import userRoutes from "./routes/userRoutes.js";
// import chatRoutes from "./routes/chatRoutes.js";
// import widgetRoutes from "./routes/widgetRoutes.js";
// import analyticsRoutes from "./routes/analyticsRoutes.js";
// import ticketRoutes from "./routes/ticketRoutes.js";
// import cannedResponseRoutes from "./routes/cannedResponseRoutes.js";

// import errorMiddleware from "./middleware/errorMiddleware.js";
// import AppError from "./utils/AppError.js";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// export function createApp() {
//   const app = express();

//   // Normalize double slashes in the URL
//   app.use((req, res, next) => {
//     req.url = req.url.replace(/\/{2,}/g, "/");
//     next();
//   });

//   // 1. GLOBAL MIDDLEWARES
//   const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
//     .split(",")
//     .map(o => o.trim().replace(/\/$/, ""));

//   app.use(cors({
//     origin: (origin, callback) => {
//       // allow server-to-server / curl / no-origin requests
//       if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) return callback(null, true);
//       callback(new Error(`CORS blocked: ${origin}`));
//     },
//     credentials: true
//   }));
//   app.use(helmet({
//     contentSecurityPolicy: false,
//     crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow widget to load cross-origin
//     crossOriginEmbedderPolicy: false
//   }));

//   if (process.env.NODE_ENV === "development") {
//     app.use(morgan("dev"));
//   }

//   const limiter = rateLimit({
//     max: 1000,
//     windowMs: 60 * 60 * 1000,
//     message: "Too many requests from this IP, please try again in an hour!"
//   });
//   app.use("/api", limiter);

//   app.use(express.json({ limit: "10kb" }));
//   app.use(cookieParser());
//   app.use(express.static(path.join(__dirname, "public")));
//   app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

//   // 2. ROUTES
//   app.get("/", (_, res) => res.json({ status: "success", message: "JTS Chat Backend is Live", version: "1.0.0" }));
//   app.get("/health", (_, res) => res.json({ ok: true, timestamp: new Date() }));

//   app.use(widgetRoutes);
//   app.use("/api/auth", authRoutes);
//   app.use("/api/websites", websiteRoutes);
//   app.use("/api/users", userRoutes);
//   app.use("/api/chat", chatRoutes);
//   app.use("/api/analytics", analyticsRoutes);
//   app.use("/api/tickets", ticketRoutes);
//   app.use("/api/canned-responses", cannedResponseRoutes);

//   // Handle undefined routes
//   app.all("*", (req, res, next) => {
//     next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
//   });

//   // 3. GLOBAL ERROR HANDLING MIDDLEWARE
//   app.use(errorMiddleware);

//   return app;
// }

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

import errorMiddleware from "./middleware/errorMiddleware.js";
import AppError from "./utils/AppError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  // Normalize double slashes in URL
  app.use((req, res, next) => {
    req.url = req.url.replace(/\/{2,}/g, "/");
    next();
  });

  // ✅ ✅ FIXED CORS (ALLOW ALL WEBSITES)
  app.use(cors({
    origin: (origin, callback) => {
      return callback(null, true); // allow all origins
    },
    credentials: true
  }));

  // ✅ IMPORTANT (handle preflight requests)
  app.options("*", cors());

  // SECURITY
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
  }));

  // LOGGING
  if (process.env.NODE_ENV === "development") {
    app.use(morgan("dev"));
  }

  // RATE LIMIT
  const limiter = rateLimit({
    max: 1000,
    windowMs: 60 * 60 * 1000,
    message: "Too many requests from this IP, please try again in an hour!"
  });
  app.use("/api", limiter);

  // BODY PARSER
  app.use(express.json({ limit: "10kb" }));
  app.use(cookieParser());

  // STATIC FILES (for widget)
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

  // ROUTES
  app.get("/", (_, res) => {
    res.json({
      status: "success",
      message: "JTS Chat Backend is Live",
      version: "1.0.0"
    });
  });

  app.get("/health", (_, res) => {
    res.json({ ok: true, timestamp: new Date() });
  });

  app.use(widgetRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/websites", websiteRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/tickets", ticketRoutes);
  app.use("/api/canned-responses", cannedResponseRoutes);

  // HANDLE UNKNOWN ROUTES
  app.all("*", (req, res, next) => {
    next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
  });

  // GLOBAL ERROR HANDLER
  app.use(errorMiddleware);

  return app;
}