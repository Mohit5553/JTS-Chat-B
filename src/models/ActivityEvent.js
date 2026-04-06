import mongoose from "mongoose";
import { ACTIVITY_ENTITY_TYPES, ACTIVITY_TYPES, ACTIVITY_VISIBILITY } from "../constants/domain.js";

const activityEventSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorName: { type: String, trim: true, default: "System" },
    actorRole: { type: String, trim: true, default: "system" },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", default: null, index: true },
    entityType: { type: String, enum: ACTIVITY_ENTITY_TYPES, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true, index: true },
    visibility: { type: String, enum: ACTIVITY_VISIBILITY, default: "internal" },
    summary: { type: String, required: true, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

activityEventSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export const ActivityEvent = mongoose.model("ActivityEvent", activityEventSchema);
