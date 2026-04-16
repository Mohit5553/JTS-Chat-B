import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { Website } from "../models/Website.js";
import { User } from "../models/User.js";
import { Visitor } from "../models/Visitor.js";
import { closeSession, findOrCreateSession, registerVisitor } from "../services/chatService.js";
import { normalizeRole, getOwnedWebsiteIds } from "../utils/roleUtils.js";
import { sendEmail } from "../services/emailService.js";
import { chatTransferredTemplate } from "../utils/emailTemplates.js";
import { env } from "../config/env.js";
import { logAuditEvent } from "../services/auditService.js";
import { createNotification } from "../services/notificationService.js";
import { createActivityEvent, listActivityForEntity } from "../services/activityService.js";
import { dispatchWebsiteWebhook } from "../services/webhookService.js";
import { emitSessionUpdate } from "../sockets/index.js";
import { PERMISSIONS, requirePermission } from "../utils/permissions.js";

async function loadRealtimeSession(id) {
  return ChatSession.findById(id)
    .populate("assignedAgent", "name email role isOnline")
    .populate("websiteId", "websiteName domain managerId")
    .populate("visitorId", "visitorId name email deviceInfo ipAddress");
}

async function userHasWebsiteAccess(user, websiteId) {
  const role = normalizeRole(user.role);
  if (role === "admin") return true;
  if (!websiteId) return false;
  const websiteIds = await getOwnedWebsiteIds(user);
  return websiteIds.some((id) => String(id) === String(websiteId));
}

function getSessionWebsiteId(session) {
  return session?.websiteId?._id || session?.websiteId || null;
}

async function hasReachedActiveChatLimit(userId) {
  const maxAllowed = 5;
  const activeCount = await ChatSession.countDocuments({ assignedAgent: userId, status: "active" });
  return activeCount >= maxAllowed;
}

async function ensureSessionStaffAccess(session, user) {
  const role = normalizeRole(user.role);
  if (role === "admin") return true;
  const sessionWebsiteId = getSessionWebsiteId(session);
  if (!sessionWebsiteId) {
    return !!session.assignedAgent && String(session.assignedAgent) === String(user._id);
  }
  if (["client", "manager"].includes(role)) {
    return userHasWebsiteAccess(user, sessionWebsiteId);
  }
  if (!await userHasWebsiteAccess(user, sessionWebsiteId)) {
    return false;
  }
  return !session.assignedAgent || String(session.assignedAgent) === String(user._id);
}

async function populateMessageNames(messages) {
  if (!messages || messages.length === 0) return [];

  // Batch-load all agent IDs at once instead of N+1 queries
  const agentIds = [...new Set(
    messages
      .filter(m => m.sender === "agent" && m.agentId)
      .map(m => m.agentId.toString())
  )];
  const agentMap = {};
  if (agentIds.length > 0) {
    const agents = await User.find({ _id: { $in: agentIds } }).select("name");
    agents.forEach(a => { agentMap[a._id.toString()] = a.name; });
  }

  // For visitor sender name, get the session once
  let visitorSessionMap = {};
  const sessionIds = [...new Set(
    messages
      .filter(m => m.sender === "visitor")
      .map(m => m.sessionId?.toString())
      .filter(Boolean)
  )];
  if (sessionIds.length > 0) {
    const sessions = await ChatSession.find({ _id: { $in: sessionIds } })
      .populate("visitorId", "name")
      .select("_id visitorId");
    sessions.forEach(s => {
      visitorSessionMap[s._id.toString()] = s.visitorId?.name || "You";
    });
  }

  return messages.map(m => {
    const plain = m.toObject();
    if (plain.sender === "agent" && plain.agentId) {
      plain.senderName = agentMap[plain.agentId.toString()] || "Support";
    } else if (plain.sender === "visitor") {
      plain.senderName = visitorSessionMap[plain.sessionId?.toString()] || "You";
    }
    return plain;
  });
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

function populateSession(query) {
  return query
    .populate("assignedAgent", "name email role isOnline")
    .populate("websiteId", "websiteName domain managerId")
    .populate("visitorId", "visitorId name email deviceInfo ipAddress browser os device country city timezone firstVisitTime lastVisitTime")
    .sort({ updatedAt: -1 });
}

export async function initVisitorSession(req, res) {
  const website = req.website;
  const { visitorToken, deviceInfo, name, email, currentPage, sessionId } = req.body;
  const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

  const { visitor } = await registerVisitor({ website, visitorToken, ipAddress, deviceInfo, name, email });
  const session = await findOrCreateSession({ website, visitor, currentPage, sessionId });
  const messages = await Message.find({ sessionId: session._id }).sort({ createdAt: 1 });
  const messagesWithNames = await populateMessageNames(messages);

  return res.json({
    visitor: visitor, // Updated to return the full visitor object
    sessionId: session.sessionId,
    session,
    messages: messagesWithNames,
    website,
    botStatus: session.botStatus,
    botMetadata: session.botMetadata
  });
}

export async function listManagerSessions(req, res) {
  requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
  const websiteIds = await getOwnedWebsiteIds(req.user);
  const sessions = await populateSession(ChatSession.find({ websiteId: { $in: websiteIds } }));
  return res.json(sessions);
}

export async function listAgentSessions(req, res) {
  requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
  const sessions = await populateSession(ChatSession.find({ assignedAgent: req.user._id }).limit(100));
  return res.json(sessions);
}

export async function listSalesSessions(req, res) {
  requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
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

  const sessionWebsiteId = getSessionWebsiteId(session);
  const role = normalizeRole(req.user.role);

  if (!sessionWebsiteId) {
    const canUseOrphanedSession = role === "admin"
      || (!!session.assignedAgent && String(session.assignedAgent) === String(req.user._id));
    if (!canUseOrphanedSession) {
      return res.status(409).json({ message: "Session is missing website linkage" });
    }
  } else if (role !== "admin" && !await userHasWebsiteAccess(req.user, sessionWebsiteId)) {
    return res.status(403).json({ message: "Access denied" });
  }

  if (role === "agent" && session.assignedAgent && session.assignedAgent.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }

  const messages = await Message.find({ sessionId: session._id }).sort({ createdAt: 1 });
  const messagesWithNames = await populateMessageNames(messages);
  return res.json(messagesWithNames);
}

export async function acceptChatSession(req, res) {
  requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("websiteId", "managerId");
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const sessionWebsiteId = getSessionWebsiteId(session);
  if (!sessionWebsiteId) {
    return res.status(409).json({ message: "Session is missing website linkage" });
  }

  const role = normalizeRole(req.user.role);
  if (role === "agent") {
    if (!session.assignedAgent && await hasReachedActiveChatLimit(req.user._id)) {
      return res.status(409).json({ message: "You can only handle up to 5 active visitors at a time" });
    }
    if (session.assignedAgent && session.assignedAgent.toString() !== req.user._id.toString()) {
      return res.status(409).json({ message: "This chat is already assigned to another user" });
    }
    if (!await userHasWebsiteAccess(req.user, sessionWebsiteId)) {
      return res.status(403).json({ message: "Access denied" });
    }
  } else if (role !== "admin") {
    if (!await userHasWebsiteAccess(req.user, sessionWebsiteId)) {
      return res.status(403).json({ message: "Access denied" });
    }
  }

  session.assignedAgent = req.user._id;
  session.status = "active";
  session.acceptedAt = session.acceptedAt || new Date();
  await session.save();

  await createNotification({
    recipient: session.websiteId.managerId,
    type: "new_chat",
    title: "Chat accepted",
    message: `${req.user.name} accepted chat ${session.sessionId}.`,
    link: `/client?tab=chats&sessionId=${session.sessionId}`,
    actor: req.user,
    entityType: "chat_session",
    entityId: session._id,
    metadata: { sessionId: session.sessionId }
  });
  await createActivityEvent({
    actor: req.user,
    websiteId: sessionWebsiteId,
    entityType: "chat_session",
    entityId: session._id,
    type: "assigned",
    summary: `Chat ${session.sessionId} was accepted`,
    metadata: { assignedAgentId: req.user._id }
  });
  await logAuditEvent({
    actor: req.user,
    action: "chat.accepted",
    entityType: "chat_session",
    entityId: session._id,
    websiteId: sessionWebsiteId,
    metadata: { sessionId: session.sessionId },
    ipAddress: req.ip
  });
  await dispatchWebsiteWebhook(sessionWebsiteId, "chat.assigned", {
    sessionId: session.sessionId,
    assignedAgentId: req.user._id,
    assignedAgentName: req.user.name
  });

  const populated = await loadRealtimeSession(session._id);
  emitSessionUpdate(populated);

  return res.json(populated);
}

export async function closeChatSession(req, res) {
  requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
  const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("websiteId", "managerId");
  if (!session) {
    return res.status(404).json({ message: "Session not found" });
  }

  const sessionWebsiteId = getSessionWebsiteId(session);
  if (!sessionWebsiteId) {
    return res.status(409).json({ message: "Session is missing website linkage" });
  }

  const role = normalizeRole(req.user.role);
  if (role !== "admin" && !await userHasWebsiteAccess(req.user, sessionWebsiteId)) {
    return res.status(403).json({ message: "Access denied" });
  }
  if (role === "agent" && session.assignedAgent?.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: "Access denied" });
  }

  const closed = await closeSession(session._id);
  await createActivityEvent({
    actor: req.user,
    websiteId: sessionWebsiteId,
    entityType: "chat_session",
    entityId: session._id,
    type: "status_changed",
    summary: `Chat ${session.sessionId} was closed`,
    metadata: { status: "closed" }
  });
  await logAuditEvent({
    actor: req.user,
    action: "chat.closed",
    entityType: "chat_session",
    entityId: session._id,
    websiteId: sessionWebsiteId,
    metadata: { sessionId: session.sessionId },
    ipAddress: req.ip
  });
  await dispatchWebsiteWebhook(sessionWebsiteId, "chat.closed", {
    sessionId: session.sessionId,
    closedBy: req.user._id
  });
  emitSessionUpdate(await loadRealtimeSession(session._id));
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
  await session.save();
  return res.json({ success: true, satisfactionStatus: session.satisfactionStatus });
}

export async function submitBotStatus(req, res) {
  const { sessionId, botStatus, path, selections } = req.body;
  const session = await ChatSession.findOne({ sessionId, websiteId: req.website._id });
  if (!session) return res.status(404).json({ message: "Session not found" });

  session.botStatus = botStatus;
  if (botStatus === "resolved") {
    session.resolvedByBot = true;
    session.status = "closed";
    session.closedAt = new Date();
  }

  if (path) session.botMetadata.path = path;
  if (selections) session.botMetadata.selections = selections;

  await session.save();
  emitSessionUpdate(await loadRealtimeSession(session._id));

  return res.json({ success: true });
}

export async function getWidgetConfig(req, res) {
  const website = req.website;

  // Check if ANY agent assigned to this website is currently online
  const managerId = website.managerId;
  const agents = await User.find({
    role: "agent",
    managerId
  }).select("isOnline lastActiveAt").lean();

  const isAgentOnline = agents.some(a => a.isOnline === true);
  const lastActiveAgent = agents
    .filter(a => a.lastActiveAt)
    .sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))[0];
  const lastActiveAt = lastActiveAgent?.lastActiveAt || null;

  // Feature 7: Business hours check
  const businessOpen = isBusinessOpen(website.businessHours);

  return res.json({
    websiteName: website.websiteName,
    primaryColor: website.primaryColor,
    accentColor: website.accentColor,
    position: website.position || "right",
    launcherIcon: website.launcherIcon,
    welcomeMessage: website.welcomeMessage,
    awayMessage: website.awayMessage,
    isAgentOnline,
    isBusinessOpen: businessOpen,
    showOfflineForm: !businessOpen || !isAgentOnline,
    lastActiveAt,
    quickReplies: website.quickReplies || [],
    businessHours: website.businessHours || null,
    botEnabled: website.botEnabled,
    botWelcomeMessage: website.botWelcomeMessage,
    botFlow: website.botFlow
  });
}


export async function getChatHistory(req, res) {
  try {
    requirePermission(req.user, PERMISSIONS.CHAT_VIEW);
    const { websiteId, agentId, startDate, endDate, searchTerm } = req.query;
    const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    const filter = { websiteId: { $in: ownedWebsiteIds } };

    if (websiteId) {
      if (ownedWebsiteIds.map(id => id.toString()).includes(websiteId)) {
        filter.websiteId = websiteId;
      }
    }

    if (agentId) filter.assignedAgent = agentId;

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    if (searchTerm) {
      const searchRegex = new RegExp(searchTerm, "i");
      const matchingVisitors = await Visitor.find({
        $or: [{ name: searchRegex }, { email: searchRegex }, { visitorId: searchRegex }]
      }).select("_id");
      // distinct("sessionId") already returns the session ObjectId references
      const matchingSessionIds = await Message.find({ message: searchRegex }).distinct("sessionId");
      const visitorIds = matchingVisitors.map(v => v._id);
      filter.$or = [
        { lastMessagePreview: searchRegex },
        { visitorId: { $in: visitorIds } },
        { _id: { $in: matchingSessionIds } }   // now correctly session ObjectIds, not message ids
      ];
    }

    const sessions = await ChatSession.find(filter)
      .populate("assignedAgent", "name email")
      .populate("websiteId", "websiteName domain")
      .populate("visitorId", "visitorId name email")
      .sort({ createdAt: -1 })
      .limit(200);

    return res.json(sessions);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ─── Feature 5: Chat Transfer ────────────────────────────────────────────────
export async function transferChatSession(req, res) {
  try {
    requirePermission(req.user, PERMISSIONS.CHAT_TRANSFER);
    const { toAgentId, note, reason = "manual_transfer" } = req.body;
    const { sessionId } = req.params;

    if (!toAgentId) return res.status(400).json({ message: "Target agent ID is required" });

    const [session, toAgent] = await Promise.all([
      ChatSession.findOne({ sessionId }).populate("visitorId", "name").populate("websiteId", "websiteName managerId"),
      User.findById(toAgentId).select("name email role managerId")
    ]);

    if (!session) return res.status(404).json({ message: "Session not found" });
    const sessionWebsiteId = getSessionWebsiteId(session);
    if (!sessionWebsiteId) return res.status(409).json({ message: "Session is missing website linkage" });
    if (!await ensureSessionStaffAccess(session, req.user)) return res.status(403).json({ message: "Access denied" });
    if (!toAgent || toAgent.role !== "agent") return res.status(400).json({ message: "Target must be an active agent" });
    if (await hasReachedActiveChatLimit(toAgent._id)) {
      return res.status(409).json({ message: "Target agent already has an active visitor" });
    }
    if (String(toAgent.managerId || "") !== String(session.websiteId.managerId || "")) {
      return res.status(400).json({ message: "Target agent must belong to the same client account" });
    }
    if (!(toAgent.websiteIds || []).some((id) => String(id) === String(sessionWebsiteId))) {
      return res.status(400).json({ message: "Target user must be assigned to this website" });
    }

    const fromAgent = req.user;
    const fromAgentId = fromAgent._id;

    // Record the transfer
    session.transferredFrom = fromAgentId;
    session.assignedAgent = toAgent._id;
    session.acceptedAt = new Date();
    if (!session.transferHistory) session.transferHistory = [];
    session.transferHistory.unshift({
      fromAgentId,
      toAgentId: toAgent._id,
      reason,
      note: note || "",
      transferredAt: new Date()
    });
    await session.save();

    // Add a system message visible in chat
    await Message.create({
      sessionId: session._id,
      sender: "system",
      message: `Chat transferred from ${fromAgent.name} to ${toAgent.name}${note ? ` — Note: ${note}` : ""}.`
    });

    // 📧 Email the new agent
    const dashboardUrl = `${env.clientUrl}/agent?tab=chats&sessionId=${sessionId}`;
    const { html, subject } = chatTransferredTemplate({
      agentName: toAgent.name,
      fromAgentName: fromAgent.name,
      visitorName: session.visitorId?.name,
      sessionId,
      dashboardUrl
    });
    await sendEmail({ to: toAgent.email, subject, html });
    await createNotification({
      recipient: toAgent._id,
      type: "new_chat",
      title: "Chat transferred to you",
      message: `${fromAgent.name} transferred chat ${sessionId} to you.`,
      link: `/client?tab=chats&sessionId=${sessionId}`,
      actor: req.user,
      entityType: "chat_session",
      entityId: session._id,
      metadata: { sessionId, reason }
    });
    await createActivityEvent({
      actor: req.user,
      websiteId: sessionWebsiteId,
      entityType: "chat_session",
      entityId: session._id,
      type: "transferred",
      summary: `Chat ${sessionId} was transferred to ${toAgent.name}`,
      metadata: { fromAgentId, toAgentId: toAgent._id, reason, note: note || "" }
    });
    await logAuditEvent({
      actor: req.user,
      action: "chat.transferred",
      entityType: "chat_session",
      entityId: session._id,
      websiteId: sessionWebsiteId,
      metadata: { sessionId, toAgentId: toAgent._id, note: note || "", reason },
      ipAddress: req.ip
    });
    await dispatchWebsiteWebhook(sessionWebsiteId, "chat.transferred", {
      sessionId,
      fromAgentId: fromAgent._id,
      toAgentId: toAgent._id,
      note: note || "",
      reason
    });

    const populated = await loadRealtimeSession(session._id);
    emitSessionUpdate(populated);

    return res.json({ success: true, session: populated });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ─── Feature 6: Internal Notes ───────────────────────────────────────────────
export async function addInternalNote(req, res) {
  try {
    requirePermission(req.user, PERMISSIONS.CHAT_NOTE);
    const { sessionId } = req.params;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ message: "Note content is required" });

    const session = await ChatSession.findOne({ sessionId }).populate("websiteId", "managerId");
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!await ensureSessionStaffAccess(session, req.user)) return res.status(403).json({ message: "Access denied" });

    const note = {
      content: content.trim(),
      agentId: req.user._id,
      agentName: req.user.name,
      createdAt: new Date()
    };
    session.internalNotes.push(note);
    await session.save();
    await createActivityEvent({
      actor: req.user,
      websiteId: session.websiteId,
      entityType: "chat_session",
      entityId: session._id,
      type: "note_added",
      summary: `An internal note was added to chat ${sessionId}`,
      metadata: { note: note.content }
    });
    await logAuditEvent({
      actor: req.user,
      action: "chat.note_added",
      entityType: "chat_session",
      entityId: session._id,
      websiteId: session.websiteId,
      metadata: { sessionId, noteLength: note.content.length },
      ipAddress: req.ip
    });
    emitSessionUpdate(await loadRealtimeSession(session._id));

    return res.json({ success: true, note: session.internalNotes[session.internalNotes.length - 1] });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getInternalNotes(req, res) {
  try {
    const { sessionId } = req.params;
    const session = await ChatSession.findOne({ sessionId }).select("internalNotes websiteId").populate("websiteId", "managerId");
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!await ensureSessionStaffAccess(session, req.user)) return res.status(403).json({ message: "Access denied" });
    return res.json(session.internalNotes || []);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function getSessionActivity(req, res) {
  try {
    requirePermission(req.user, PERMISSIONS.ACTIVITY_VIEW);
    const { sessionId } = req.params;
    const session = await ChatSession.findOne({ sessionId }).select("_id websiteId assignedAgent").populate("websiteId", "managerId");
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!await ensureSessionStaffAccess(session, req.user)) return res.status(403).json({ message: "Access denied" });
    const activity = await listActivityForEntity({ entityType: "chat_session", entityId: session._id, limit: 100 });
    return res.json(activity);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function bulkCloseSessions(req, res) {
  try {
    const { sessionIds } = req.body;
    if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ message: "sessionIds array is required" });
    }

    const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    const sessions = await ChatSession.find({ sessionId: { $in: sessionIds }, websiteId: { $in: ownedWebsiteIds } });

    for (const session of sessions) {
      if (session.status !== "closed") {
        await closeSession(session._id);
        await logAuditEvent({
          actor: req.user,
          action: "chat.bulk_closed",
          entityType: "chat_session",
          entityId: session._id,
          websiteId: session.websiteId,
          metadata: { sessionId: session.sessionId },
          ipAddress: req.ip
        });
        emitSessionUpdate(await loadRealtimeSession(session._id));
      }
    }

    res.json({ message: "Bulk close completed", count: sessions.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function bulkReassignSessions(req, res) {
  try {
    const { sessionIds, toAgentId } = req.body;
    if (!sessionIds || !toAgentId) return res.status(400).json({ message: "sessionIds and toAgentId are required" });

    const role = normalizeRole(req.user.role);
    if (!["admin", "client", "manager"].includes(role)) {
      return res.status(403).json({ message: "Only managers can reassign sessions in bulk" });
    }

    const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    const [sessions, toAgent] = await Promise.all([
      ChatSession.find({ sessionId: { $in: sessionIds }, websiteId: { $in: ownedWebsiteIds } }),
      User.findById(toAgentId)
    ]);

    if (!toAgent) return res.status(404).json({ message: "Target agent not found" });

    for (const session of sessions) {
      session.assignedAgent = toAgent._id;
      session.status = "active";
      if (!session.transferHistory) session.transferHistory = [];
      session.transferHistory.unshift({
        fromAgentId: req.user._id,
        toAgentId: toAgent._id,
        reason: "bulk_reassignment",
        transferredAt: new Date()
      });
      await session.save();

      await logAuditEvent({
        actor: req.user,
        action: "chat.bulk_reassigned",
        entityType: "chat_session",
        entityId: session._id,
        websiteId: session.websiteId,
        metadata: { sessionId: session.sessionId, toAgentId: toAgent._id },
        ipAddress: req.ip
      });
      emitSessionUpdate(await loadRealtimeSession(session._id));
    }

    res.json({ message: "Bulk reassignment completed", count: sessions.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function bulkDeleteSessions(req, res) {
  try {
    const role = normalizeRole(req.user.role);
    if (!["admin", "client", "manager"].includes(role)) {
      return res.status(403).json({ message: "Only managers can delete sessions" });
    }

    const { sessionIds } = req.body;
    const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    const sessions = await ChatSession.find({ sessionId: { $in: sessionIds }, websiteId: { $in: ownedWebsiteIds } });

    for (const session of sessions) {
      await logAuditEvent({
        actor: req.user,
        action: "chat.bulk_deleted",
        entityType: "chat_session",
        entityId: session._id,
        websiteId: session.websiteId,
        metadata: { sessionId: session.sessionId },
        ipAddress: req.ip
      });
      await session.deleteOne();
    }

    res.json({ message: "Bulk deletion completed", count: sessions.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function deleteChatSession(req, res) {
  try {
    const role = normalizeRole(req.user.role);
    if (!["admin", "client", "manager"].includes(role)) {
      return res.status(403).json({ message: "Only managers can delete sessions" });
    }

    const { sessionId } = req.params;
    const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    const session = await ChatSession.findOne({ sessionId, websiteId: { $in: ownedWebsiteIds } });

    if (!session) return res.status(404).json({ message: "Session not found" });

    await logAuditEvent({
      actor: req.user,
      action: "chat.deleted",
      entityType: "chat_session",
      entityId: session._id,
      websiteId: session.websiteId,
      metadata: { sessionId: session.sessionId },
      ipAddress: req.ip
    });

    await session.deleteOne();
    res.json({ message: "Session deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ─── Feature 7: Business Hours helper ────────────────────────────────────────
export function isBusinessOpen(businessHours) {
  if (!businessHours?.enabled) return true; // if not configured → always open

  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const tz = businessHours.timezone || "Asia/Kolkata";

  // Get current time in the configured timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const dayName = parts.find(p => p.type === "weekday")?.value?.toLowerCase();
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const currentMinutes = hour * 60 + minute;

  const dayConfig = businessHours[dayName];
  if (!dayConfig || !dayConfig.isOpen) return false;

  const [openH, openM] = (dayConfig.open || "09:00").split(":").map(Number);
  const [closeH, closeM] = (dayConfig.close || "17:00").split(":").map(Number);
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  if (closeMinutes < openMinutes) {
    return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
  }
  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}
