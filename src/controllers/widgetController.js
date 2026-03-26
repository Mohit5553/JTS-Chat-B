import { Website } from "../models/Website.js";
import { User } from "../models/User.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { findOrCreateSession } from "../services/chatService.js";
import { env } from "../config/env.js";

export const getWidgetScript = asyncHandler(async (req, res) => {
  const widgetUrl = env.widgetPublicUrl;
  const scriptOrigin = new URL(widgetUrl).origin;

  const script = `
(function() {
  const currentScript = document.currentScript;
  const apiKey = currentScript && currentScript.getAttribute('data-api-key');
  if (!apiKey) return;
  const origin = "${scriptOrigin}";
  const s = document.createElement('script');
  s.src = "${widgetUrl}";
  s.setAttribute('data-api-key', apiKey);
  document.head.appendChild(s);
})();
  `;
  res.type("application/javascript").send(script);
});

export const getWidgetConfig = async (req, res) => {
  try {
    const { apiKey } = req.params;
    const website = await Website.findOne({ apiKey });
    if (!website) return res.status(404).json({ message: "Invalid API Key" });
    if (website.isActive === false) return res.status(403).json({ message: "Widget disabled" });
    res.json(website);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const initWidget = asyncHandler(async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  const { visitorToken, name, email } = req.body;
  const website = await Website.findOne({ apiKey });
  if (!website) throw new AppError("Invalid API Key", 400);
  if (website.isActive === false) throw new AppError("Widget disabled", 403);

  let visitor = null;
  if (visitorToken) {
    visitor = await User.findOne({ visitorId: visitorToken });
  } else if (name && email) {
    const visitorId = `VIS-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
    visitor = new User({ name, email, role: "visitor", visitorId, managerId: website.managerId });
    await visitor.save();
  }

  let session = null;
  if (visitor) {
    session = await findOrCreateSession({ website, visitor });
  }

  const messages = session ? await Message.find({ sessionId: session.sessionId }).sort({ createdAt: 1 }) : [];

  res.json({
    status: "success",
    visitorId: visitor?.visitorId,
    visitor,
    sessionId: session?.sessionId,
    session,
    website: {
      websiteName: website.websiteName,
      primaryColor: website.primaryColor,
      accentColor: website.accentColor,
      launcherIcon: website.launcherIcon,
      awayMessage: website.awayMessage
    },
    messages
  });
});

export const submitFeedback = asyncHandler(async (req, res) => {
  const { sessionId, satisfactionStatus } = req.body;
  const session = await ChatSession.findOneAndUpdate(
    { sessionId },
    { satisfactionStatus, satisfactionSubmittedAt: new Date() },
    { new: true }
  );
  if (!session) throw new AppError("Session not found", 404);
  res.json({ status: "success", session });
});
