import { ActivityEvent } from "../models/ActivityEvent.js";
import { Visitor } from "../models/Visitor.js";
import asyncHandler from "../utils/asyncHandler.js";
import { createActivityEvent } from "../services/activityService.js";

/**
 * Log a page view event from the visitor-side script
 */
export const logPageView = asyncHandler(async (req, res) => {
  const { websiteId, visitorId, url, title, referrer } = req.body;

  if (!websiteId || !visitorId || !url) {
    return res.status(400).json({ message: "Missing tracking data" });
  }

  // Find the visitor to see if they are a known customer
  const visitor = await Visitor.findOne({ websiteId, visitorId });
  
  // Log the event
  // We log it with entityType "website" but include visitorId in metadata
  // If we have a customerId, we could also log it for the customer
  await createActivityEvent({
    websiteId,
    entityType: visitor?.customerId ? "customer" : "website",
    entityId: visitor?.customerId || websiteId,
    type: "page_view",
    summary: `Viewed page: ${title || url}`,
    metadata: {
      url,
      title,
      referrer,
      visitorId,
      userAgent: req.headers["user-agent"],
      ip: req.ip
    }
  });

  res.status(204).end();
});
