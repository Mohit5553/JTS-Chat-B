import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { Website } from "../models/Website.js";
import { User } from "../models/User.js";
import { closeSession, findOrCreateSession, registerVisitor } from "../services/chatService.js";

async function populateMessageNames(messages) {
  const result = [];
  for (const m of messages) {
    const plain = m.toObject();
    if (plain.sender === "agent" && plain.agentId) {
      const agent = await User.findById(plain.agentId).select("name");
      plain.senderName = agent?.name || "Support";
    } else if (plain.sender === "visitor") {
      const session = await ChatSession.findById(plain.sessionId).populate("visitorId");
      plain.senderName = session?.visitorId?.name || "You";
    }
    result.push(plain);
  }
  return result;
}

function normalizeRole(role) {
  return role === "manager" ? "admin" : role;
}

export async function uploadAttachment(req, res) {
  if (!req.file) return res.status(400).json({ message: "No file provided" });
  
  const protocol = req.protocol;
  const host = req.get("host");
  const url = `${protocol}://${host}/uploads/${req.file.filename}`;
  
  // Decide attachment type pseudo-logic
  const mimetype = req.file.mimetype;
  let attachmentType = "file";
  if (mimetype.startsWith("image/")) attachmentType = "image";
  else if (mimetype === "application/pdf") attachmentType = "pdf";

  return res.json({ url, attachmentType });
}

async function getOwnedWebsiteIds(user) {
  const role = normalizeRole(user.role);
  if (role === "admin") {
    const websites = await Website.find({}).select("_id");
    return websites.map((website) => website._id);
  }

  if (role === "client") {
    const websites = await Website.find({ managerId: user._id }).select("_id");
    return websites.map((website) => website._id);
  }

  return [];
}

function populateSession(query) {
  return query
    .populate("assignedAgent", "name email role isOnline")
    .populate("websiteId", "websiteName domain managerId")
    .populate("visitorId", "visitorId deviceInfo ipAddress")
    .sort({ updatedAt: -1 });
}

export async function initVisitorSession(req, res) {
  const website = req.website;
  const { visitorToken, deviceInfo, name, email } = req.body;
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

  const { visitor } = await registerVisitor({ website, visitorToken, ipAddress, deviceInfo, name, email });
  const session = await findOrCreateSession({ website, visitor });
  const messages = await Message.find({ sessionId: session._id }).sort({ createdAt: 1 });
  const messagesWithNames = await populateMessageNames(messages);

  return res.json({
    visitor: visitor, // Updated to return the full visitor object
    sessionId: session.sessionId,
    session,
    messages: messagesWithNames,
    website
  });
}

export async function listManagerSessions(req, res) {
  const websiteIds = await getOwnedWebsiteIds(req.user);
  const sessions = await populateSession(ChatSession.find({ websiteId: { $in: websiteIds } }));
  return res.json(sessions);
}

export async function listAgentSessions(req, res) {
  const sessions = await populateSession(ChatSession.find({ assignedAgent: req.user._id }).limit(100));
  return res.json(sessions);
}

export async function listQueuedSessions(req, res) {
  const websiteIds = await getOwnedWebsiteIds(req.user);
  const sessions = await populateSession(
    ChatSession.find({ websiteId: { $in: websiteIds }, status: "queued" })
  );
  return res.json(sessions);
}

export async function getSessionMessages(req, res) {
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("websiteId", "managerId");
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const role = normalizeRole(req.user.role);
  if (role === "client" && session.websiteId.managerId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }
  if (role === "agent" && session.assignedAgent?.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }

  const messages = await Message.find({ sessionId: session._id }).sort({ createdAt: 1 });
  const messagesWithNames = await populateMessageNames(messages);
  return res.json(messagesWithNames);
}

export async function acceptChatSession(req, res) {
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("websiteId", "managerId");
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const role = normalizeRole(req.user.role);
  if (role === "agent") {
    if (session.assignedAgent && session.assignedAgent.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "This chat is already assigned to another user" });
    }
    if (session.websiteId.managerId.toString() !== req.user.managerId?.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
  } else if (role === "client") {
    if (session.websiteId.managerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }
  }

  session.assignedAgent = req.user._id;
  session.status = "active";
  session.acceptedAt = session.acceptedAt || new Date();
  await session.save();

  const populated = await ChatSession.findById(session._id)
    .populate("assignedAgent", "name email role isOnline")
    .populate("websiteId", "websiteName domain managerId")
    .populate("visitorId", "visitorId deviceInfo ipAddress");

  return res.json(populated);
}

export async function closeChatSession(req, res) {
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("websiteId", "managerId");
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const role = normalizeRole(req.user.role);
  if (role === "client" && session.websiteId.managerId.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }
  if (role === "agent" && session.assignedAgent?.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }

  const closed = await closeSession(session._id);
  return res.json(closed);
}

export async function submitSessionFeedback(req, res) {
  const { sessionId, satisfactionStatus } = req.body;
  if (!["satisfied", "unsatisfied"].includes(satisfactionStatus)) {
    return res.status(400).json({ message: "Invalid satisfaction status" });
  }

  const session = await ChatSession.findOne({ sessionId, websiteId: req.website._id });
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  session.satisfactionStatus = satisfactionStatus;
  session.satisfactionSubmittedAt = new Date();
  await session.save();

  return res.json({ success: true, satisfactionStatus: session.satisfactionStatus });
}
