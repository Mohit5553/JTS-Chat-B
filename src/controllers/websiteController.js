import { Website } from "../models/Website.js";
import { getOwnedWebsiteIds } from "../utils/roleUtils.js";
import { generateApiKey } from "../utils/generateKey.js";
import { ensureAnalytics } from "../services/analyticsService.js";
import { env } from "../config/env.js";
import { logAuditEvent } from "../services/auditService.js";
import { User } from "../models/User.js";
import { resolveSubscriptionForUser } from "../utils/planUtils.js";

function buildEmbedScript(apiKey) {
  return `<script>\n  (function(){\n    var s = document.createElement("script");\n    s.src = "${env.widgetPublicUrl}";\n    s.setAttribute("data-api-key", "${apiKey}");\n    document.body.appendChild(s);\n  })();\n</script>`;
}

export async function createWebsite(req, res) {
  const tenantId = req.user.role === "client" ? req.user._id : req.user.managerId;
  const tenant = req.user.role === "client" ? req.user : await User.findById(tenantId).select("subscription");
  const subscription = resolveSubscriptionForUser(tenant);
  const websiteCount = await Website.countDocuments({ managerId: tenantId });
  if (websiteCount >= (subscription.limits?.websites || 0)) {
    return res.status(403).json({ message: `Your ${subscription.plan} plan allows up to ${subscription.limits?.websites || 0} websites.` });
  }

  const website = await Website.create({
    websiteName: req.body.websiteName,
    domain: req.body.domain,
    managerId: tenantId,
    apiKey: generateApiKey(),
    primaryColor: req.body.primaryColor,
    accentColor: req.body.accentColor,
    launcherIcon: req.body.launcherIcon,
    welcomeMessage: req.body.welcomeMessage,
    awayMessage: req.body.awayMessage,
    position: req.body.position,
    quickReplies: req.body.quickReplies,
    isActive: req.body.isActive !== undefined ? req.body.isActive : true,
    businessHours: req.body.businessHours,
    webhooks: req.body.webhooks
  });

  await ensureAnalytics(website._id);
  await logAuditEvent({
    actor: req.user,
    action: "website.created",
    entityType: "website",
    entityId: website._id,
    websiteId: website._id,
    metadata: { websiteName: website.websiteName, domain: website.domain },
    ipAddress: req.ip
  });
  const enriched = { ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) };
  return res.status(201).json(enriched);
}

export async function updateWebsite(req, res) {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (req.user.role !== "admin" && !ownedWebsiteIds.map(id => id.toString()).includes(req.params.id)) {
    return res.status(403).json({ message: "Access denied" });
  }
  const filter = { _id: req.params.id };
  const website = await Website.findOneAndUpdate(
    filter,
    {
      websiteName: req.body.websiteName,
      domain: req.body.domain,
      primaryColor: req.body.primaryColor,
      accentColor: req.body.accentColor,
      launcherIcon: req.body.launcherIcon,
      welcomeMessage: req.body.welcomeMessage,
      awayMessage: req.body.awayMessage,
      position: req.body.position,
      quickReplies: req.body.quickReplies,
      businessHours: req.body.businessHours,
      webhooks: req.body.webhooks,
      ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {})
    },
    { new: true }
  );

  if (!website) return res.status(404).json({ message: "Website not found" });
  await logAuditEvent({
    actor: req.user,
    action: "website.updated",
    entityType: "website",
    entityId: website._id,
    websiteId: website._id,
    metadata: {
      websiteName: website.websiteName,
      updatedFields: Object.keys(req.body || {})
    },
    ipAddress: req.ip
  });
  return res.json({ ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) });
}

export async function listWebsites(req, res) {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const filter = req.user.role === "admin" ? {} : { _id: { $in: ownedWebsiteIds } };
  const websites = await Website.find(filter).populate("managerId", "name email").sort({ createdAt: -1 });
  return res.json(websites.map((website) => ({ ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) })));
}
