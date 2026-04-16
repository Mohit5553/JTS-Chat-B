import { AuditLog } from "../models/AuditLog.js";
import { getOwnedWebsiteIds, normalizeRole } from "../utils/roleUtils.js";

export async function listAuditLogs(req, res) {
  try {
    const filter = {};
    const { websiteId, entityType, action, entityId } = req.query;
    const role = normalizeRole(req.user.role);

    if (role === "client") {
      const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
      filter.websiteId = { $in: ownedWebsiteIds };
      if (websiteId && ownedWebsiteIds.some((id) => id.toString() === websiteId)) {
        filter.websiteId = websiteId;
      }
    } else if (websiteId) {
      filter.websiteId = websiteId;
    }

    if (entityType) filter.entityType = entityType;
    if (action) filter.action = action;
    if (entityId) filter.entityId = entityId;

    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(200);

    const isInternal = ["admin", "client", "manager"].includes(role);
    const sanitizedLogs = isInternal ? logs : logs.map(log => {
      const plainLog = log.toObject();
      if (plainLog.metadata) {
        if (plainLog.metadata.email) plainLog.metadata.email = maskEmail(plainLog.metadata.email);
        if (plainLog.ipAddress) plainLog.ipAddress = maskIp(plainLog.ipAddress);
        // mask other potential PII in nested fields if needed
      }
      return plainLog;
    });

    res.json(sanitizedLogs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return email;
  const [name, domain] = email.split("@");
  if (!domain) return "****";
  return `${name[0]}***@${domain}`;
}

function maskIp(ip) {
  if (!ip || typeof ip !== "string") return ip;
  return ip.replace(/\d+\.\d+$/, "***.***");
}
