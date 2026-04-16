import mongoose from "mongoose";

function normalizeCategoryList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
}

const twoFactorTempSchema = new mongoose.Schema({
  secret: { type: String, default: null },
  expiresAt: { type: Date, default: null }
}, { _id: false });

const planLimitsSchema = new mongoose.Schema({
  agents: { type: Number, default: 10 },
  websites: { type: Number, default: 5 }
}, { _id: false });

const subscriptionSchema = new mongoose.Schema({
  plan: { type: String, enum: ["basic", "standard", "pro"], default: "pro" },
  status: { type: String, enum: ["trial", "active", "suspended", "expired"], default: "active" },
  enabledModules: {
    type: [String],
    default: ["chat", "tickets", "crm", "shortcuts", "reports", "security"]
  },
  limits: { type: planLimitsSchema, default: () => ({}) }
}, { _id: false });

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "client", "agent", "manager", "user", "sales"], required: true },
    isOnline: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true },
    currentWorkload: { type: Number, default: 0 },
    maxWorkload: { type: Number, default: 5 },
    department: { type: String, trim: true, lowercase: true, default: "general" },
    assignedCategories: {
      type: [String],
      default: [],
      set: normalizeCategoryList
    },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    websiteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Website" }],
    lastActiveAt: { type: Date, default: Date.now },
    // Password Reset
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: null },
    twoFactorTemp: { type: twoFactorTempSchema, default: () => ({}) },
    subscription: { type: subscriptionSchema, default: () => ({}) },
    // Stripe Integration
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    // Advanced CRM Tier-2 Fields
    specialties: { type: [String], default: [] }, // e.g., ["technical", "medical", "legal"]
    territories: { type: [String], default: [] }, // e.g., ["india", "usa", "emea"]
    monthlyTarget: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
