import mongoose from "mongoose";

const analyticsSchema = new mongoose.Schema(
  {
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true, unique: true },
    totalVisitors: { type: Number, default: 0 },
    activeChats: { type: Number, default: 0 },
    resolvedChats: { type: Number, default: 0 },
    avgResponseTimeSeconds: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export const Analytics = mongoose.model("Analytics", analyticsSchema);
