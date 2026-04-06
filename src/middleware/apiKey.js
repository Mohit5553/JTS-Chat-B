import { Website } from "../models/Website.js";
import { matchesWebsiteDomain } from "../utils/domain.js";

export async function requireWebsiteApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"] || req.query.apiKey;

  if (!apiKey) {
    return res.status(401).json({ message: "API key is required" });
  }

  const website = await Website.findOne({ apiKey });
  if (!website) {
    return res.status(401).json({ message: "Invalid API key" });
  }

  const requestOrigin = req.headers.origin || req.headers.referer || "";
  if (requestOrigin && !matchesWebsiteDomain(requestOrigin, website.domain)) {
    return res.status(403).json({ message: "Origin does not match registered website domain" });
  }

  req.website = website;
  next();
}
