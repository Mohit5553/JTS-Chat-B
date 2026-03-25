import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { Visitor } from "../models/Visitor.js";
import { findAvailableAgent } from "./assignmentService.js";
import { generatePublicId } from "../utils/generateKey.js";
import { incrementActiveChats, incrementResolvedChats, incrementVisitors, updateAverageResponseTime } from "./analyticsService.js";

import geoip from "geoip-lite";

export async function registerVisitor({ website, visitorToken, ipAddress, deviceInfo, name, email }) {
  const visitorId = visitorToken || generatePublicId("visitor");
  const existing = await Visitor.findOne({ visitorId, websiteId: website._id });

  // Use geoip lookup for location data
  const geo = geoip.lookup(ipAddress === "::1" || ipAddress === "127.0.0.1" ? "8.8.8.8" : ipAddress);
  const location = {
    city: geo?.city || "Unknown",
    country: geo?.country || "Unknown",
    timezone: geo?.timezone || "UTC"
  };

  if (existing) {
    existing.lastVisitTime = new Date();
    existing.deviceInfo = deviceInfo || existing.deviceInfo;
    existing.ipAddress = ipAddress || existing.ipAddress;
    existing.name = name || existing.name;
    existing.email = email || existing.email;
    existing.city = location.city;
    existing.country = location.country;
    existing.timezone = location.timezone;
    await existing.save();
    return { visitor: existing, isNew: false };
  }

  const visitor = await Visitor.create({
    visitorId,
    websiteId: website._id,
    ipAddress,
    deviceInfo,
    name,
    email,
    city: location.city,
    country: location.country,
    timezone: location.timezone
  });

  await incrementVisitors(website._id);
  return { visitor, isNew: true };
}

export async function findOrCreateSession({ website, visitor }) {
  let session = await ChatSession.findOne({
    websiteId: website._id,
    visitorId: visitor._id,
    status: { $in: ["active", "queued"] }
  }).populate("assignedAgent", "name email isOnline");

  if (session) {
    return session;
  }

  const agent = await findAvailableAgent(website.managerId);
  const status = agent ? "active" : "queued";

  session = await ChatSession.create({
    sessionId: generatePublicId("session"),
    websiteId: website._id,
    visitorId: visitor._id,
    assignedAgent: agent?._id || null,
    status
  });

  await incrementActiveChats(website._id, 1);

  return ChatSession.findById(session._id).populate("assignedAgent", "name email isOnline");
}

export async function addMessage({ chatSession, sender, message, attachmentUrl = null, attachmentType = null, agentId = null }) {
  // Gracefully handle empty message if attachment exists to satisfy Mongoose validation
  const msgText = (message && message.trim()) ? message : (attachmentUrl ? "Sent an attachment" : "");
  
  const savedMessage = await Message.create({
    sessionId: chatSession._id,
    sender,
    message: msgText,
    attachmentUrl,
    attachmentType,
    agentId
  });

  // Update session with latest metadata for faster dashboard rendering
  await ChatSession.findByIdAndUpdate(chatSession._id, {
    lastMessageAt: savedMessage.createdAt,
    lastMessagePreview: msgText.length > 50 ? msgText.substring(0, 47) + "..." : msgText
  });

  return savedMessage;
}

export async function closeSession(sessionId) {
  const session = await ChatSession.findById(sessionId);
  if (!session || session.status === "closed") {
    return session;
  }

  session.status = "closed";
  session.closedAt = new Date();
  await session.save();

  await incrementResolvedChats(session.websiteId);

  if (session.firstResponseAt) {
    const responseSeconds = Math.max(1, Math.round((session.firstResponseAt.getTime() - session.createdAt.getTime()) / 1000));
    await updateAverageResponseTime(session.websiteId, responseSeconds);
  }

  return session;
}
