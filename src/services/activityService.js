import { ActivityEvent } from "../models/ActivityEvent.js";

export async function createActivityEvent({
  actor = null,
  websiteId = null,
  entityType,
  entityId,
  type,
  summary,
  visibility = "internal",
  metadata = {}
}) {
  if (!entityType || !entityId || !type || !summary) return null;

  try {
    return await ActivityEvent.create({
      actorId: actor?._id || null,
      actorName: actor?.name || "System",
      actorRole: actor?.role || "system",
      websiteId,
      entityType,
      entityId: String(entityId),
      type,
      summary,
      visibility,
      metadata
    });
  } catch (error) {
    console.error("Activity event error:", error.message);
    return null;
  }
}

export async function listActivityForEntity({ entityType, entityId, limit = 50 }) {
  return ActivityEvent.find({ entityType, entityId: String(entityId) })
    .sort({ createdAt: -1 })
    .limit(limit);
}
