import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { Visitor } from "../models/Visitor.js";
import { findAvailableAgent } from "./assignmentService.js";
import { generatePublicId } from "../utils/generateKey.js";
import { incrementActiveChats, incrementResolvedChats, incrementVisitors, updateAverageResponseTime } from "./analyticsService.js";
import { getOrCreateCustomer } from "./customerService.js";
import geoip from "geoip-lite";
import { UAParser } from "ua-parser-js";

export async function registerVisitor({ website, visitorToken, ipAddress, deviceInfo, name, email }) {
  const visitorId = visitorToken || generatePublicId("visitor");
  const existing = await Visitor.findOne({ visitorId, websiteId: website._id });

  // Parse UAs
  const parser = new UAParser(deviceInfo);
  const uaRes = parser.getResult();
  const browser = `${uaRes.browser.name || ""} ${uaRes.browser.version || ""}`.trim() || "Unknown";
  const os = `${uaRes.os.name || ""} ${uaRes.os.version || ""}`.trim() || "Unknown";
  const device = `${uaRes.device.vendor || ""} ${uaRes.device.model || ""}`.trim() || "Desktop";

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
    existing.browser = browser;
    existing.os = os;
    existing.device = device;
    await existing.save();

    // If returning visitor now provides email/name and didn't have a CRN yet, upgrade their CRM record
    if (!existing.crn && (name || email)) {
      const customer = await getOrCreateCustomer({
        name: name || existing.name,
        email: email || existing.email,
        websiteId: website._id,
        visitorId: existing.visitorId
      });
      if (customer) {
        existing.customerId = customer._id;
        existing.crn = customer.crn;
        await existing.save();
      }
    }

    return { visitor: existing, isNew: false };
  }

  const visitor = await Visitor.create({
    visitorId,
    websiteId: website._id,
    ipAddress,
    deviceInfo,
    browser,
    os,
    device,
    name,
    email,
    city: location.city,
    country: location.country,
    timezone: location.timezone
  });

  // CRN Integration: Create/update Customer record for ALL visitors (identified or anonymous)
  const customer = await getOrCreateCustomer({ 
    name, 
    email, 
    websiteId: website._id,
    visitorId: visitorId  // used as fallback unique key for anonymous visitors
  });
  if (customer) {
    visitor.customerId = customer._id;
    visitor.crn = customer.crn;
    await visitor.save();
  }

  await incrementVisitors(website._id);
  return { visitor, isNew: true };
}

export async function findOrCreateSession({ website, visitor, currentPage = "", sessionId = null }) {
  let session = null;

  if (sessionId) {
    session = await ChatSession.findOne({ 
      sessionId, 
      websiteId: website._id,
      visitorId: visitor._id 
    }).populate("assignedAgent", "name email isOnline");
  }

  if (!session) {
    session = await ChatSession.findOne({
      websiteId: website._id,
      visitorId: visitor._id,
      status: { $in: ["active", "queued"] }
    }).populate("assignedAgent", "name email isOnline");
  }

  if (session) {
    if (currentPage && session.currentPage !== currentPage) {
      if (!session.firstPage) session.firstPage = currentPage;
      session.visitHistory = Array.isArray(session.visitHistory) ? session.visitHistory : [];
      if (!session.visitHistory.includes(currentPage)) {
        session.visitHistory.push(currentPage);
      }
      session.currentPage = currentPage;
      await session.save();
    }
    return session;
  }

  const agent = await findAvailableAgent({ managerId: website.managerId, websiteId: website._id });
  const status = agent ? "active" : "queued";

  session = await ChatSession.create({
    sessionId: generatePublicId("session"),
    websiteId: website._id,
    visitorId: visitor._id,
    customerId: visitor.customerId || null,
    crn: visitor.crn || null,
    assignedAgent: agent?._id || null,
    status,
    currentPage,
    firstPage: currentPage,
    visitHistory: currentPage ? [currentPage] : []
  });

  await incrementActiveChats(website._id, 1);

  return ChatSession.findById(session._id).populate("assignedAgent", "name email isOnline");
}

export async function addMessage({ chatSession, sender, message, attachmentUrl = null, attachmentType = null, agentId = null }) {
  try {
    if (!chatSession?._id) {
       console.error("[SERVICE_ERROR]: addMessage called without valid chatSession._id");
       throw new Error("Invalid session ID for message");
    }

    // Gracefully handle empty message if attachment exists to satisfy Mongoose validation
    const msgText = (message && message.trim()) ? message : (attachmentUrl ? "Sent an attachment" : "");
    
    console.log(`[SERVICE_TRACE]: Attempting to create message for session ${chatSession._id} from ${sender}`);
    const savedMessage = await Message.create({
      sessionId: chatSession._id,
      sender,
      message: msgText,
      attachmentUrl,
      attachmentType,
      agentId: agentId || null
    });

    console.log(`[SERVICE_TRACE]: Message created successfully: ${savedMessage._id}`);

    // Update session with latest metadata for faster dashboard rendering
    const update = {
      $set: {
        lastMessageAt: savedMessage.createdAt,
        lastMessagePreview: msgText.length > 50 ? msgText.substring(0, 47) + "..." : msgText
      }
    };
    if (sender === "visitor") {
      update.$inc = { unreadCount: 1 };
    } else {
      update.$set.unreadCount = 0;
    }
    await ChatSession.findByIdAndUpdate(chatSession._id, update);

    return savedMessage;
  } catch (err) {
    console.error(`[SERVICE_FATAL]: Message creation failed:`, err);
    throw err;
  }
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
