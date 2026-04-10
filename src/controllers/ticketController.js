import crypto from "crypto";
import { Ticket } from "../models/Ticket.js";
import { ChatSession } from "../models/ChatSession.js";
import { Website } from "../models/Website.js";
import { User } from "../models/User.js";
import { sendEmail } from "../services/emailService.js";
import { getOwnedWebsiteIds, normalizeRole } from "../utils/roleUtils.js";
import { createNotification } from "../services/notificationService.js";
import { logAuditEvent } from "../services/auditService.js";
import { createActivityEvent, listActivityForEntity } from "../services/activityService.js";
import { dispatchWebsiteWebhook } from "../services/webhookService.js";
import { addMessage } from "../services/chatService.js";
import { ticketCreatedTemplate, ticketUpdatedTemplate } from "../utils/emailTemplates.js";
import { env } from "../config/env.js";
import { findDefaultCrmOwner } from "../services/customerService.js";
import { findAvailableAgent } from "../services/assignmentService.js";
import { Category } from "../models/Category.js";
import { Customer } from "../models/Customer.js";
import { getSocketServer } from "../sockets/index.js";
import { PERMISSIONS, requirePermission } from "../utils/permissions.js";

function normalizeDepartment(value) {
  return String(value || "").trim().toLowerCase() || "general";
}

function mapTicketCrmStageToPipelineStage(crmStage) {
  const stage = String(crmStage || "").trim().toLowerCase();
  if (!stage || stage === "none") return null;
  if (stage === "lead") return "new";
  if (stage === "qualified") return "qualified";
  if (stage === "opportunity" || stage === "proposal" || stage === "negotiation") return "proposition";
  if (stage === "won") return "won";
  if (stage === "lost") return "lost";
  return null;
}

function buildTicketId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `TKT-${timestamp}-${rand}`;
}

function ticketToCsvRow(ticket) {
  const fields = [
    ticket.ticketId,
    ticket.subject,
    ticket.status,
    ticket.priority,
    ticket.crmStage || "none",
    ticket.websiteId?.websiteName || "",
    ticket.visitorId?.name || "",
    ticket.visitorId?.email || "",
    ticket.assignedAgent?.name || "",
    ticket.assignedAt?.toISOString?.() || "",
    ticket.createdAt?.toISOString?.() || "",
    ticket.updatedAt?.toISOString?.() || ""
  ];

  return fields
    .map((value) => `"${String(value).replace(/"/g, '""')}"`)
    .join(",");
}

function pushAssignmentHistory(ticket, { assignedAgentId, assignedBy, reason }) {
  if (!ticket.assignmentHistory) ticket.assignmentHistory = [];
  ticket.assignmentHistory.unshift({
    assignedAgent: assignedAgentId || null,
    assignedBy: assignedBy || null,
    reason: reason || "",
    assignedAt: new Date()
  });
  ticket.assignedAt = assignedAgentId ? new Date() : null;
  ticket.assignedBy = assignedBy || null;
  ticket.assignmentReason = reason || "";
}

async function reassignTicketByDepartmentIfNeeded(ticket, actorId) {
  const matchedAgent = await findAvailableAgent({
    managerId: ticket.websiteId?.managerId || ticket.websiteId,
    websiteId: ticket.websiteId?._id || ticket.websiteId,
    category: ticket.department,
    roles: ["agent", "sales", "user"]
  });

  if (!matchedAgent) return false;
  if (String(ticket.assignedAgent || "") === String(matchedAgent._id)) return false;

  ticket.assignedAgent = matchedAgent._id;
  pushAssignmentHistory(ticket, {
    assignedAgentId: matchedAgent._id,
    assignedBy: actorId || null,
    reason: "department_reassignment"
  });
  return true;
}

async function syncSalesOwnerFromTicket(ticket, actorId, reason = "sales_ticket_assignment") {
  if (!ticket?.assignedAgent) return false;

  const assignee = await User.findById(ticket.assignedAgent).select("_id role");
  if (!assignee || assignee.role !== "sales") return false;

  let customer = null;
  if (ticket.customerId) {
    customer = await Customer.findById(ticket.customerId);
  } else if (ticket.crn) {
    customer = await Customer.findOne({ crn: ticket.crn, websiteId: ticket.websiteId });
  }
  if (!customer) return false;
  if (String(customer.ownerId || "") === String(assignee._id)) return false;

  customer.ownerId = assignee._id;
  customer.ownerAssignedAt = new Date();
  customer.lastInteraction = new Date();
  if (!customer.assignmentHistory) customer.assignmentHistory = [];
  customer.assignmentHistory.unshift({
    ownerId: assignee._id,
    assignedBy: actorId || null,
    reason,
    assignedAt: new Date()
  });
  await customer.save();
  return true;
}

async function notifyAssignedAgent(ticket, previousAssignedAgentId = null) {
  if (!ticket.assignedAgent) return;
  const agent = await User.findById(ticket.assignedAgent).select("name email");
  if (!agent) return;
  if (previousAssignedAgentId && String(previousAssignedAgentId) === String(agent._id)) return;

  await createNotification({
    recipient: agent._id,
    type: "new_ticket",
    title: "Ticket assigned to you",
    message: `${ticket.ticketId} has been assigned to you.`,
    link: "/client?tab=tickets",
    entityType: "ticket",
    entityId: ticket._id,
    metadata: { ticketId: ticket.ticketId }
  });
}

async function notifyVisitorOfTicketCreation({ ticket, visitorEmail, websiteName }) {
  if (!visitorEmail) return;
  const statusUrl = `${env.clientUrl}/ticket-status/${ticket.ticketId}`;
  const { html, subject } = ticketCreatedTemplate({
    ticketId: ticket.ticketId,
    subject: ticket.subject,
    statusUrl,
    priority: ticket.priority,
    websiteName: websiteName || "Support"
  });
  await sendEmail({ to: visitorEmail, subject, html });
}

async function notifyVisitorOfTicketUpdate({ ticket, status, prevStatus, note }) {
  const visitor = await Ticket.findById(ticket._id).populate("visitorId", "email");
  const visitorEmail = visitor?.visitorId?.email;
  if (!visitorEmail || !status || status === prevStatus) return;

  const statusUrl = `${env.clientUrl}/ticket-status/${ticket.ticketId}`;
  const agent = ticket.assignedAgent ? await User.findById(ticket.assignedAgent).select("name") : null;
  const { html, subject } = ticketUpdatedTemplate({
    ticketId: ticket.ticketId,
    subject: ticket.subject,
    status,
    statusUrl,
    agentName: agent?.name,
    note
  });
  await sendEmail({ to: visitorEmail, subject, html });
}

async function createManagerTicketNotification(ticket) {
  const website = await Website.findById(ticket.websiteId).select("managerId");
  if (!website?.managerId) return;
  await createNotification({
    recipient: website.managerId,
    type: "new_ticket",
    title: "New ticket created",
    message: `${ticket.ticketId} was created: ${ticket.subject}`,
    link: "/client?tab=tickets"
  });
}

async function shareTicketLinkInChat({ session, ticket, actor }) {
  if (!session?._id || !ticket?.ticketId) return;

  const statusUrl = `${env.clientUrl}/ticket-status/${ticket.ticketId}`;
  const messageText = `Your support ticket has been created. You can track it here: ${statusUrl}`;
  const saved = await addMessage({
    chatSession: session,
    sender: "agent",
    message: messageText,
    agentId: actor?._id || null
  });

  const payload = {
    _id: saved._id,
    sessionId: session.sessionId,
    message: saved.message,
    attachmentUrl: saved.attachmentUrl,
    attachmentType: saved.attachmentType,
    sender: "agent",
    senderName: actor?.name || "Support",
    createdAt: saved.createdAt,
    agentId: actor?._id || null
  };

  const io = getSocketServer();
  if (!io) return;

  io.to(session.sessionId).emit("chat:message", payload);

  const websiteId = session.websiteId?._id || session.websiteId || null;
  const managerId = session.websiteId?.managerId || null;
  const assignedAgentId = session.assignedAgent?._id || session.assignedAgent || null;

  if (websiteId) {
    io.to(`ws_${websiteId}`).emit("chat:new-message", payload);
  }
  if (managerId) {
    io.to(`us_${managerId}`).emit("chat:new-message", payload);
  }
  if (assignedAgentId) {
    io.to(`us_${assignedAgentId}`).emit("chat:message", payload);
  }
  io.to("us_admin").emit("chat:new-message", payload);
}

async function buildTicketScopeFilter(user) {
  const role = normalizeRole(user.role);

  if (role === "admin") {
    return {};
  }

  if (["client", "manager"].includes(role)) {
    const ownedWebsiteIds = await getOwnedWebsiteIds(user);
    return { websiteId: { $in: ownedWebsiteIds } };
  }

  return { assignedAgent: user._id };
}

async function buildSessionScopeFilter(user) {
  const role = normalizeRole(user.role);

  if (role === "admin") {
    return {};
  }

  if (["client", "manager", "sales"].includes(user.role)) {
    const ownedWebsiteIds = await getOwnedWebsiteIds(user);
    return { websiteId: { $in: ownedWebsiteIds } };
  }

  return { assignedAgent: user._id };
}

async function findScopedTicketById(ticketId, user) {
  const scope = await buildTicketScopeFilter(user);
  return Ticket.findOne({ _id: ticketId, ...scope });
}

async function ensureSessionTicketAccess(session, user) {
  const role = normalizeRole(user.role);
  const sessionWebsiteId = session?.websiteId?._id || session?.websiteId || null;
  const websiteManagerId = session?.websiteId?.managerId || null;

  if (role === "admin") {
    return true;
  }

  if (!sessionWebsiteId) {
    return String(session.assignedAgent || "") === String(user._id);
  }

  if (["client", "manager"].includes(role)) {
    const ownedWebsiteIds = await getOwnedWebsiteIds(user);
    return ownedWebsiteIds.some((id) => String(id) === String(sessionWebsiteId));
  }

  const ownedWebsiteIds = await getOwnedWebsiteIds(user);
  if (String(session.assignedAgent || "") !== String(user._id)) {
    return false;
  }

  const hasWebsiteScope = ownedWebsiteIds.some((id) => String(id) === String(sessionWebsiteId));
  if (hasWebsiteScope) {
    return true;
  }

  // Legacy fallback: older personnel records may not have explicit websiteIds,
  // but the assigned agent should still be able to convert their own session
  // within the same tenant/client account.
  if (websiteManagerId) {
    return String(user.managerId || user._id || "") === String(websiteManagerId);
  }

  return true;
}

export const getTickets = async (req, res) => {
  try {
    requirePermission(req.user, PERMISSIONS.TICKET_VIEW);
    const { websiteId, status, priority, crmStage, crn } = req.query;
    const filter = await buildTicketScopeFilter(req.user);

    if (websiteId) filter.websiteId = websiteId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (crmStage) filter.crmStage = crmStage;
    if (crn) filter.crn = crn;

    if (websiteId && ["client", "manager"].includes(normalizeRole(req.user.role))) {
      const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
      const stringifiedIds = ownedWebsiteIds.map((id) => id.toString());
      if (!stringifiedIds.includes(websiteId)) {
        return res.status(403).json({ message: "Access denied to this website" });
      }
    }

    const tickets = await Ticket.find(filter)
      .populate("visitorId", "name email")
      .populate("customerId", "name email crn")
      .populate("assignedAgent", "name email")
      .populate("assignmentHistory.assignedAgent", "name email role")
      .populate("assignmentHistory.assignedBy", "name email role")
      .populate("websiteId", "websiteName domain")
      .sort({ createdAt: -1 });

    res.json(tickets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const exportTickets = async (req, res) => {
  try {
    const filter = await buildTicketScopeFilter(req.user);

    const tickets = await Ticket.find(filter)
      .populate("visitorId", "name email")
      .populate("assignedAgent", "name")
      .populate("websiteId", "websiteName");

    const header = [
      "Ticket ID",
      "Subject",
      "Status",
      "Priority",
      "CRM Stage",
      "Website",
      "Visitor Name",
      "Visitor Email",
      "Assigned Agent",
      "Assigned At",
      "Created At",
      "Updated At"
    ].join(",");

    const csv = [header, ...tickets.map(ticketToCsvRow)].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="tickets-export.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTicketByPublicId = async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.ticketId })
      .populate("websiteId", "websiteName domain primaryColor")
      .populate("assignedAgent", "name")
      .populate("assignmentHistory.assignedAgent", "name")
      .populate("assignmentHistory.assignedBy", "name");

    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    res.json({
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      channel: ticket.channel,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      website: ticket.websiteId ? {
        name: ticket.websiteId.websiteName,
        domain: ticket.websiteId.domain,
        primaryColor: ticket.websiteId.primaryColor
      } : null,
      agent: ticket.assignedAgent ? { name: ticket.assignedAgent.name } : null,
      assignment: {
        assignedAt: ticket.assignedAt,
        assignmentReason: ticket.assignmentReason,
        escalationLevel: ticket.escalationLevel || 0,
        history: (ticket.assignmentHistory || []).map((entry) => ({
          assignedAgentName: entry.assignedAgent?.name || null,
          assignedByName: entry.assignedBy?.name || null,
          reason: entry.reason || "",
          assignedAt: entry.assignedAt
        }))
      },
      notes: (ticket.notes || []).filter((n) => n.isPublic).map((n) => ({
        content: n.content,
        createdAt: n.createdAt
      })),
      metrics: {
        firstResponseAt: ticket.firstResponseAt,
        resolvedAt: ticket.resolvedAt,
        responseTimeMinutes: ticket.firstResponseAt ? Math.round((new Date(ticket.firstResponseAt) - new Date(ticket.createdAt)) / 60000) : null,
        resolutionTimeMinutes: ticket.resolvedAt ? Math.round((new Date(ticket.resolvedAt) - new Date(ticket.createdAt)) / 60000) : null
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createTicketFromChat = async (req, res) => {
  try {
    requirePermission(req.user, PERMISSIONS.TICKET_UPDATE);
    const { sessionId, subject, priority, crmStage, category, subcategory } = req.body;
    const session = await ChatSession.findById(sessionId)
      .populate("visitorId")
      .populate("websiteId", "websiteName domain managerId");

    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!(await ensureSessionTicketAccess(session, req.user))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const matchedCategory = category
      ? await Category.findOne({
          websiteId: session.websiteId?._id || session.websiteId,
          name: new RegExp(`^${String(category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
        }).select("department name")
      : null;
    const department = normalizeDepartment(
      matchedCategory?.department || category || (crmStage && crmStage !== "none" ? "sales" : "general")
    );
    const autoAssignedAgent = await findAvailableAgent({
      managerId: session.websiteId?.managerId,
      websiteId: session.websiteId?._id || session.websiteId,
      category: department,
      roles: ["agent", "sales", "user"]
    });

    const ticket = new Ticket({
      ticketId: buildTicketId(),
      shareToken: crypto.randomBytes(12).toString("hex"),
      websiteId: session.websiteId,
      visitorId: session.visitorId?._id || null,
      customerId: session.customerId || null,
      crn: session.crn || null,
      assignedAgent: autoAssignedAgent?._id || session.assignedAgent || req.user._id,
      subject: subject || "Support Request from Live Chat",
      priority: priority || "medium",
      crmStage: crmStage || "none",
      category: matchedCategory?.name || category || "",
      subcategory: subcategory || "",
      department,
      status: "open",
      lastMessagePreview: session.lastMessagePreview
    });
    if (ticket.assignedAgent) {
      pushAssignmentHistory(ticket, {
        assignedAgentId: ticket.assignedAgent,
        assignedBy: req.user._id,
        reason: autoAssignedAgent?._id ? "department_auto_assignment" : "chat_owner_default"
      });
    }

    await ticket.save();
    await syncSalesOwnerFromTicket(ticket, req.user._id, "sales_ticket_auto_link");
    if (ticket.customerId && crmStage && crmStage !== "none") {
      const customer = await Customer.findById(ticket.customerId);
      if (customer) {
        const nextStatus = crmStage === "won" ? "customer" : "lead";
        const nextPipelineStage = mapTicketCrmStageToPipelineStage(crmStage);
        if (customer.status === "prospect" || customer.status === "inactive") {
          customer.status = nextStatus;
        }
        if (nextPipelineStage) {
          customer.pipelineStage = nextPipelineStage;
        }
        if (!customer.ownerId && session.websiteId?.managerId) {
          const ownerId = await findDefaultCrmOwner({
            websiteId: session.websiteId._id || session.websiteId,
            managerId: session.websiteId.managerId
          });
          if (ownerId) {
            customer.ownerId = ownerId;
            customer.ownerAssignedAt = new Date();
            if (!customer.assignmentHistory) customer.assignmentHistory = [];
            customer.assignmentHistory.unshift({
              ownerId,
              assignedBy: req.user._id,
              reason: "ticket_converted_to_crm_stage",
              assignedAt: new Date()
            });
          }
        }
        await customer.save();
      }
    }
    await notifyVisitorOfTicketCreation({
      ticket,
      visitorEmail: session.visitorId?.email,
      websiteName: session.websiteId?.websiteName
    });
    await shareTicketLinkInChat({ session, ticket, actor: req.user });
    await notifyAssignedAgent(ticket);
    await createManagerTicketNotification(ticket);
    await dispatchWebsiteWebhook(ticket.websiteId, "ticket.created", {
      ticketId: ticket.ticketId,
      status: ticket.status,
      subject: ticket.subject
    });
    await createActivityEvent({
      actor: req.user,
      websiteId: ticket.websiteId,
      entityType: "ticket",
      entityId: ticket._id,
      type: "created",
      summary: `Ticket ${ticket.ticketId} was created`,
      metadata: { sessionId, crmStage: ticket.crmStage, department: ticket.department }
    });
    await logAuditEvent({
      actor: req.user,
      action: "ticket.created_from_chat",
      entityType: "ticket",
      entityId: ticket._id,
      websiteId: ticket.websiteId,
      metadata: { ticketId: ticket.ticketId, sessionId },
      ipAddress: req.ip
    });

    res.status(201).json({ ...ticket.toObject(), shareToken: ticket.shareToken });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateTicket = async (req, res) => {
  try {
    requirePermission(req.user, PERMISSIONS.TICKET_UPDATE);
    const { id } = req.params;
    const { status, priority, stage, crmStage, category, subcategory, note, noteIsPublic, assignedAgent, assignmentReason, escalationLevel, watchers, archiveReason } = req.body;

    const ticket = await findScopedTicketById(id, req.user);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    await ticket.populate("visitorId", "name email");

    const prevStatus = ticket.status;
    const prevAssignedAgent = ticket.assignedAgent;

    if (status) {
      ticket.status = status;
      if (status === "resolved" || status === "closed") {
        ticket.resolvedAt = new Date();
      }
    }
    if (priority) ticket.priority = priority;
    if (crmStage || stage) {
      if (!["admin", "client", "manager", "sales"].includes(req.user.role)) {
        return res.status(403).json({ message: "Only sales or managers can change CRM stage." });
      }
      if (crmStage) ticket.crmStage = crmStage;
      if (stage) ticket.crmStage = stage;
    }
    if (category !== undefined) {
      const matchedUpdateCategory = category
        ? await Category.findOne({
            websiteId: ticket.websiteId,
            name: new RegExp(`^${String(category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
          }).select("department name")
        : null;
      ticket.category = matchedUpdateCategory?.name || category;
      ticket.department = normalizeDepartment(matchedUpdateCategory?.department || category || ticket.department);
      if (ticket.department) {
        await reassignTicketByDepartmentIfNeeded(ticket, req.user._id);
      }
    }
    if (subcategory !== undefined) ticket.subcategory = subcategory;
    if (escalationLevel !== undefined) ticket.escalationLevel = escalationLevel;
    if (watchers !== undefined && ["manager", "client", "admin"].includes(req.user.role)) {
      ticket.watchers = watchers;
    }
    if (assignedAgent !== undefined) {
      if (!["manager", "client", "admin"].includes(req.user.role)) {
        return res.status(403).json({ message: "Only managers can assign or reassign tickets." });
      }
      ticket.assignedAgent = assignedAgent || null;
      pushAssignmentHistory(ticket, {
        assignedAgentId: ticket.assignedAgent,
        assignedBy: req.user._id,
        reason: assignmentReason || (assignedAgent ? "manual_reassignment" : "manual_unassignment")
      });
    }

    if (note) {
      if (!ticket.notes) ticket.notes = [];
      if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
      ticket.notes.push({
        content: note,
        addedBy: req.user._id,
        isPublic: noteIsPublic !== false,
        createdAt: new Date()
      });
    }
    if (status === "archived") {
      ticket.archivedAt = new Date();
      ticket.archivedBy = req.user._id;
      ticket.archiveReason = archiveReason || "manual_archive";
    } else if (ticket.archivedAt && status && status !== "archived") {
      ticket.restoredAt = new Date();
      ticket.restoredBy = req.user._id;
      ticket.archivedAt = null;
      ticket.archivedBy = null;
      ticket.archiveReason = "";
    }

    await ticket.save();
    await syncSalesOwnerFromTicket(ticket, req.user._id, assignedAgent !== undefined ? "sales_ticket_manual_link" : "sales_ticket_assignment_update");
    await notifyVisitorOfTicketUpdate({
      ticket,
      status,
      prevStatus,
      note: note && noteIsPublic !== false ? note : null
    });
    await notifyAssignedAgent(ticket, prevAssignedAgent);
    await dispatchWebsiteWebhook(ticket.websiteId, "ticket.updated", {
      ticketId: ticket.ticketId,
      status: ticket.status,
      priority: ticket.priority,
      assignedAgent: ticket.assignedAgent
    });
    await createActivityEvent({
      actor: req.user,
      websiteId: ticket.websiteId,
      entityType: "ticket",
      entityId: ticket._id,
      type: status === "archived" ? "archived" : assignedAgent !== undefined ? "assigned" : note ? "comment_added" : "updated",
      summary: status === "archived"
        ? `Ticket ${ticket.ticketId} was archived`
        : assignedAgent !== undefined
          ? `Ticket ${ticket.ticketId} assignment was updated`
          : note
            ? `A ${noteIsPublic === false ? "private" : "public"} note was added to ${ticket.ticketId}`
            : `Ticket ${ticket.ticketId} was updated`,
      metadata: {
        status,
        priority,
        crmStage: crmStage || stage,
        assignedAgent,
        note,
        noteIsPublic: noteIsPublic !== false,
        watchers: ticket.watchers || []
      }
    });
    await logAuditEvent({
      actor: req.user,
      action: "ticket.updated",
      entityType: "ticket",
      entityId: ticket._id,
      websiteId: ticket.websiteId,
      metadata: {
        ticketId: ticket.ticketId,
        changed: { status, priority, crmStage: crmStage || stage, assignedAgent, noteAdded: !!note }
      },
      ipAddress: req.ip
    });

    const updated = await Ticket.findById(id)
      .populate("visitorId", "name email")
      .populate("assignedAgent", "name email")
      .populate("assignmentHistory.assignedAgent", "name email role")
      .populate("assignmentHistory.assignedBy", "name email role")
      .populate("websiteId", "websiteName domain");

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const bulkUpdateTickets = async (req, res) => {
  try {
    const { ticketIds, updates } = req.body;
    if (!ticketIds || !ticketIds.length) {
      return res.status(400).json({ message: "ticketIds array is required" });
    }

    const allowedUpdates = {};
    const role = normalizeRole(req.user.role);
    if (updates.status) allowedUpdates.status = updates.status;
    if (updates.priority) allowedUpdates.priority = updates.priority;
    if (updates.crmStage) {
      if (!["admin", "client", "manager", "sales"].includes(req.user.role)) {
        return res.status(403).json({ message: "Only sales or managers can change CRM stage." });
      }
      allowedUpdates.crmStage = updates.crmStage;
    }
    if (updates.category !== undefined) {
      allowedUpdates.category = updates.category;
      allowedUpdates.department = normalizeDepartment(updates.category);
    }
    if (updates.subcategory !== undefined) allowedUpdates.subcategory = updates.subcategory;
    if (updates.escalationLevel !== undefined) allowedUpdates.escalationLevel = updates.escalationLevel;
    if (updates.assignedAgent !== undefined) {
      if (!["admin", "client", "manager"].includes(role)) {
        return res.status(403).json({ message: "Only managers can assign or reassign tickets." });
      }
      allowedUpdates.assignedAgent = updates.assignedAgent || null;
    }
    if (updates.status === "resolved" || updates.status === "closed") {
      allowedUpdates.resolvedAt = new Date();
    }

    const scope = await buildTicketScopeFilter(req.user);
    const scopedTickets = await Ticket.find({ _id: { $in: ticketIds }, ...scope });
    for (const ticket of scopedTickets) {
      Object.assign(ticket, allowedUpdates);
      if (updates.category !== undefined) {
        const matchedBulkCategory = updates.category
          ? await Category.findOne({
              websiteId: ticket.websiteId,
              name: new RegExp(`^${String(updates.category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
            }).select("department name")
          : null;
        ticket.category = matchedBulkCategory?.name || updates.category;
        ticket.department = normalizeDepartment(matchedBulkCategory?.department || updates.category || ticket.department);
        await reassignTicketByDepartmentIfNeeded(ticket, req.user._id);
      }
      if (updates.assignedAgent !== undefined) {
        pushAssignmentHistory(ticket, {
          assignedAgentId: updates.assignedAgent || null,
          assignedBy: req.user._id,
          reason: updates.assignmentReason || (updates.assignedAgent ? "bulk_assignment" : "bulk_unassignment")
        });
      }
      await ticket.save();
      await syncSalesOwnerFromTicket(ticket, req.user._id, updates.assignedAgent !== undefined ? "sales_ticket_bulk_link" : "sales_ticket_assignment_update");
    }

    await logAuditEvent({
      actor: req.user,
      action: "ticket.bulk_updated",
      entityType: "ticket_bulk",
      entityId: ticketIds.join(","),
      metadata: { updates, count: ticketIds.length },
      ipAddress: req.ip
    });

    res.json({ success: true, modifiedCount: scopedTickets.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const submitVisitorTicket = async (req, res) => {
  try {
    const { apiKey, name, email, subject, message, visitorId } = req.body;
    const website = await Website.findOne({ apiKey });
    if (!website) return res.status(400).json({ message: "Invalid API Key" });

    const newTicket = new Ticket({
      ticketId: buildTicketId(),
      shareToken: crypto.randomBytes(12).toString("hex"),
      websiteId: website._id,
      visitorId: visitorId || null,
      subject: subject || "Inquiry from Offline Widget",
      lastMessagePreview: message,
      status: "open",
      priority: "medium",
      channel: "web"
    });

    await newTicket.save();

    if (email) {
      const { getOrCreateCustomer } = await import("../services/customerService.js");
      const customer = await getOrCreateCustomer({ name, email, websiteId: website._id });
      if (customer) {
        newTicket.customerId = customer._id;
        newTicket.crn = customer.crn;
        if (!customer.ownerId && website.managerId) {
          const ownerId = await findDefaultCrmOwner({ websiteId: website._id, managerId: website.managerId });
          if (ownerId) {
            customer.ownerId = ownerId;
            customer.ownerAssignedAt = new Date();
            if (!customer.assignmentHistory) customer.assignmentHistory = [];
            customer.assignmentHistory.unshift({
              ownerId,
              assignedBy: null,
              reason: "offline_ticket_followup",
              assignedAt: new Date()
            });
            await customer.save();
          }
        }
        await newTicket.save();
      }
    }

    await notifyVisitorOfTicketCreation({
      ticket: newTicket,
      visitorEmail: email,
      websiteName: website.websiteName
    });
    await createManagerTicketNotification(newTicket);
    await dispatchWebsiteWebhook(newTicket.websiteId, "ticket.created", {
      ticketId: newTicket.ticketId,
      status: newTicket.status,
      subject: newTicket.subject,
      channel: newTicket.channel
    });

    res.status(201).json({
      message: "Ticket submitted successfully",
      ticketId: newTicket.ticketId,
      shareToken: newTicket.shareToken,
      statusUrl: `/ticket-status/${newTicket.ticketId}`
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getVisitorHistory = async (req, res) => {
  try {
    const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("visitorId");
    if (!session) return res.status(404).json({ message: "Session not found" });
    if (!(await ensureSessionTicketAccess(session, req.user))) {
      return res.status(403).json({ message: "Access denied" });
    }

    const visitorId = session.visitorId?._id;
    if (!visitorId) return res.json({ tickets: [], pastSessions: 0, visitor: null, hasOpenTickets: false });

    const ticketScope = await buildTicketScopeFilter(req.user);
    const sessionScope = await buildSessionScopeFilter(req.user);

    const [tickets, pastSessions] = await Promise.all([
      Ticket.find({ visitorId, ...ticketScope })
        .populate("assignedAgent", "name email")
        .populate("websiteId", "websiteName domain")
        .sort({ createdAt: -1 })
        .limit(10),
      ChatSession.countDocuments({ visitorId, status: "closed", ...sessionScope })
    ]);

    res.json({
      visitor: {
        _id: session.visitorId._id,
        name: session.visitorId.name,
        email: session.visitorId.email,
        visitorId: session.visitorId.visitorId,
        crn: session.crn
      },
      tickets,
      pastSessions,
      hasOpenTickets: tickets.some((t) => t.status === "open" || t.status === "pending")
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getCustomerHistoryByCRN = async (req, res) => {
  try {
    const { crn } = req.params;
    const ticketScope = await buildTicketScopeFilter(req.user);
    const sessionScope = await buildSessionScopeFilter(req.user);
    const [tickets, sessions] = await Promise.all([
      Ticket.find({ crn, ...ticketScope })
        .populate("assignedAgent", "name")
        .populate("websiteId", "websiteName")
        .sort({ createdAt: -1 }),
      ChatSession.find({ crn, ...sessionScope })
        .populate("assignedAgent", "name")
        .populate("websiteId", "websiteName")
        .sort({ createdAt: -1 })
    ]);
    res.json({ tickets, sessions });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTicketActivity = async (req, res) => {
  try {
    requirePermission(req.user, PERMISSIONS.ACTIVITY_VIEW);
    const ticket = await findScopedTicketById(req.params.id, req.user);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    const activity = await listActivityForEntity({ entityType: "ticket", entityId: ticket._id, limit: 100 });
    res.json(activity);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
