import mongoose from "mongoose";

const analyticsSnapshotSchema = new mongoose.Schema(
  {
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true, index: true },
    hour: { type: Date, required: true, index: true }, // Truncated to the hour
    totalVisitors: { type: Number, default: 0 },
    totalCustomers: { type: Number, default: 0 },
    activeChats: { type: Number, default: 0 },
    resolvedChats: { type: Number, default: 0 },
    avgWaitTimeSeconds: { type: Number, default: 0 },
    avgHandleTimeSeconds: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Ensure one snapshot per website per hour
analyticsSnapshotSchema.index({ websiteId: 1, hour: 1 }, { unique: true });

export const AnalyticsSnapshot = mongoose.model("AnalyticsSnapshot", analyticsSnapshotSchema);
