import mongoose from "mongoose";

const websiteSchema = new mongoose.Schema(
  {
    websiteName: { type: String, required: true, trim: true },
    domain: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true, unique: true, index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    primaryColor: { type: String, default: "#004e64" },
    accentColor: { type: String, default: "#00a5cf" },
    launcherIcon: { type: String, default: "💬" },
    awayMessage: { type: String, default: "Hello! We're currently offline, but if you leave a message, we'll get back to you shortly." },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const Website = mongoose.model("Website", websiteSchema);
