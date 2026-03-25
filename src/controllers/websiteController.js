import { Website } from "../models/Website.js";
import { generateApiKey } from "../utils/generateKey.js";
import { ensureAnalytics } from "../services/analyticsService.js";
import { env } from "../config/env.js";

function buildEmbedScript(apiKey) {
  return `<script>\n  (function(){\n    var s = document.createElement("script");\n    s.src = "${env.widgetPublicUrl}";\n    s.setAttribute("data-api-key", "${apiKey}");\n    document.body.appendChild(s);\n  })();\n</script>`;
}

export async function createWebsite(req, res) {
  const website = await Website.create({
    websiteName: req.body.websiteName,
    domain: req.body.domain,
    managerId: req.user._id,
    apiKey: generateApiKey(),
    primaryColor: req.body.primaryColor,
    accentColor: req.body.accentColor,
    launcherIcon: req.body.launcherIcon,
    awayMessage: req.body.awayMessage,
    isActive: req.body.isActive !== undefined ? req.body.isActive : true
  });

  await ensureAnalytics(website._id);
  const enriched = { ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) };
  return res.status(201).json(enriched);
}

export async function updateWebsite(req, res) {
  const filter = req.user.role === "admin" ? { _id: req.params.id } : { _id: req.params.id, managerId: req.user._id };
  const website = await Website.findOneAndUpdate(
    filter,
    {
      websiteName: req.body.websiteName,
      domain: req.body.domain,
      primaryColor: req.body.primaryColor,
      accentColor: req.body.accentColor,
      launcherIcon: req.body.launcherIcon,
      awayMessage: req.body.awayMessage,
      ...(req.body.isActive !== undefined ? { isActive: req.body.isActive } : {})
    },
    { new: true }
  );

  if (!website) return res.status(404).json({ message: "Website not found" });
  return res.json({ ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) });
}

export async function listWebsites(req, res) {
  const filter = req.user.role === "admin" ? {} : { managerId: req.user._id };
  const websites = await Website.find(filter).populate("managerId", "name email").sort({ createdAt: -1 });
  return res.json(websites.map((website) => ({ ...website.toObject(), embedScript: buildEmbedScript(website.apiKey) })));
}
