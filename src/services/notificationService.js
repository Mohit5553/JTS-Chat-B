import { Notification } from "../models/Notification.js";

export async function createNotification({
  recipient,
  type,
  title,
  message,
  link = "",
  actor = null,
  entityType = "",
  entityId = "",
  metadata = {}
}) {
  if (!recipient || !type || !title || !message) return null;

  try {
    return await Notification.create({
      recipient,
      type,
      title,
      message,
      link,
      actorId: actor?._id || null,
      actorName: actor?.name || "",
      entityType,
      entityId: entityId ? String(entityId) : "",
      metadata
    });
  } catch (error) {
    console.error("Notification create error:", error.message);
    return null;
  }
}
