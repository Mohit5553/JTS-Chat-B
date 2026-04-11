import mongoose from "mongoose";

const dayHoursSchema = new mongoose.Schema({
  isOpen: { type: Boolean, default: true },
  open: { type: String, default: "09:00" },
  close: { type: String, default: "17:00" }
}, { _id: false });

const webhookSchema = new mongoose.Schema({
  url: { type: String, required: true, trim: true },
  secret: { type: String, trim: true, default: "" },
  events: [{ type: String, trim: true }],
  isActive: { type: Boolean, default: true }
}, { _id: true });

const websiteSchema = new mongoose.Schema(
  {
    websiteName: { type: String, required: true, trim: true },
    domain: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true, unique: true, index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    primaryColor: { type: String, default: "#004e64" },
    accentColor: { type: String, default: "#00a5cf" },
    launcherIcon: { type: String, default: "💬" },
    welcomeMessage: { type: String, default: "Hi there! How can we help you today?" },
    awayMessage: { type: String, default: "Hello! We're currently offline, but if you leave a message, we'll get back to you shortly." },
    position: { type: String, enum: ["left", "right"], default: "right" },
    quickReplies: [
      {
        text: { type: String, required: true },
        autoResponse: { type: String }
      }
    ],
    isActive: { type: Boolean, default: true },
    businessHours: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, default: "Asia/Kolkata" },
      monday:    { type: dayHoursSchema, default: () => ({}) },
      tuesday:   { type: dayHoursSchema, default: () => ({}) },
      wednesday: { type: dayHoursSchema, default: () => ({}) },
      thursday:  { type: dayHoursSchema, default: () => ({}) },
      friday:    { type: dayHoursSchema, default: () => ({}) },
      saturday:  { type: dayHoursSchema, default: () => ({ isOpen: false }) },
      sunday:    { type: dayHoursSchema, default: () => ({ isOpen: false }) },
    },
    webhooks: [webhookSchema],
    botEnabled: { type: Boolean, default: true },
    botWelcomeMessage: { type: String, default: "Hi 👋 How can we help you today?" },
    botFlow: {
      type: mongoose.Schema.Types.Mixed,
      default: {
        nodes: {
          root: {
            message: "Hi 👋 How can we help you?",
            options: [
              { text: "Sales", next: "sales" },
              { text: "Support", next: "support" },
              { text: "Billing", next: "billing" },
              { text: "Technical", next: "technical" }
            ]
          },
          support: {
            message: "Which support area do you need help with?",
            options: [
              { text: "Login Issue", next: "support_login" },
              { text: "Account Issue", next: "support_account" },
              { text: "Payment Problem", next: "support_payment" }
            ]
          },
          support_login: {
            message: "Select your specific login issue:",
            options: [
              { text: "Forgot Password", next: "sol_forgot_password" },
              { text: "OTP not received", next: "sol_otp" },
              { text: "Invalid credentials", next: "sol_invalid_creds" }
            ]
          },
          sol_forgot_password: {
            message: "🔧 Solution:\n1. Click on \"Forgot Password\"\n2. Enter your email\n3. Check spam folder for OTP",
            isSolution: true
          }
        }
      }
    }
  },
  { timestamps: true }
);

export const Website = mongoose.model("Website", websiteSchema);
