import { AuditLog } from "../models/AuditLog.js";
import { getOwnedWebsiteIds, normalizeRole } from "../utils/roleUtils.js";

export async function listAuditLogs(req, res) {
  try {
    const filter = {};
    const { websiteId, entityType, action } = req.query;
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

    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(200);

    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}
