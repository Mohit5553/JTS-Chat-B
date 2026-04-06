import { AuditLog } from "../models/AuditLog.js";

export async function logAuditEvent({
  actor = null,
  action,
  entityType,
  entityId,
  websiteId = null,
  metadata = {},
  ipAddress = ""
}) {
  if (!action || !entityType || !entityId) return null;

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
