import { AuditLog } from "../models/AuditLog.js";

export async function logAuditEvent({
  actor = null,
  action,
  entityType,
  entityId,
  websiteId = null,
  metadata = {},
  ipAddress = "",
  before = null,
  after = null
}) {
  if (!action || !entityType || !entityId) return null;

  // Calculate diff if before and after are provided
  if (before && after) {
    const diff = {};
    const beforeObj = before.toObject ? before.toObject() : before;
    const afterObj = after.toObject ? after.toObject() : after;

    Object.keys(afterObj).forEach(key => {
      // Skip internal fields and unchanged fields
      if (key.startsWith('_') || key === 'updatedAt' || key === 'createdAt' || key === '__v') return;
      
      const bStr = JSON.stringify(beforeObj[key]);
      const aStr = JSON.stringify(afterObj[key]);
      
      if (bStr !== aStr) {
        diff[key] = {
          before: beforeObj[key],
          after: afterObj[key]
        };
      }
    });

    if (Object.keys(diff).length > 0) {
      metadata.diff = diff;
    }
  }

  try {
    return await AuditLog.create({
      actorId: actor?._id || null,
      actorName: actor?.name || "System",
      actorRole: actor?.role || "system",
      action,
      entityType,
      entityId: String(entityId),
      websiteId,
      metadata,
      ipAddress
    });
  } catch (error) {
    console.error("Audit log error:", error.message);
    return null;
  }
}
