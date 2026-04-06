import dotenv from "dotenv";

dotenv.config();

const mongoUri = process.env.MONGODB_URI?.trim();

if (!mongoUri) {
  throw new Error(
    "MONGODB_URI is required. Set it to your MongoDB connection string (Atlas, Render managed database, etc.) before starting the server."
  );
}

export const env = {
  port: Number(process.env.PORT || 5000),
  mongoUri,
  jwtSecret: process.env.JWT_SECRET || "change-me",
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  widgetPublicUrl: process.env.WIDGET_PUBLIC_URL || (process.env.NODE_ENV === "production" ? "https://chat-backend-3pcj.onrender.com/chat-widget.js" : "http://localhost:5000/chat-widget.js"),
  // CORS — comma-separated list of allowed origins
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174,http://localhost:4173").split(",").map(o => o.trim()),
  // SMTP / Email config
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "noreply@chatsupport.app",
  // SLA Thresholds
  slaQueueAlertMinutes: Number(process.env.SLA_QUEUE_ALERT_MINUTES || 5),
  slaTicketAlertHours: Number(process.env.SLA_TICKET_ALERT_HOURS || 24),
  // Stripe Integration
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePriceIds: {
    basic: process.env.STRIPE_BASIC_PRICE_ID || "price_basic_placeholder",
    standard: process.env.STRIPE_STANDARD_PRICE_ID || "price_standard_placeholder",
    pro: process.env.STRIPE_PRO_PRICE_ID || "price_pro_placeholder"
  }
};
