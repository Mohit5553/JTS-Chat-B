import { Customer } from "../models/Customer.js";
import { ChatSession } from "../models/ChatSession.js";
import { Ticket } from "../models/Ticket.js";
import { User } from "../models/User.js";
import { FollowUpTask } from "../models/FollowUpTask.js";
import { getOwnedWebsiteIds } from "../utils/roleUtils.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { sendEmail } from "../services/emailService.js";
import { salesOutreachTemplate } from "../utils/emailTemplates.js";
import { generateCRN } from "../services/customerService.js";
import { incrementCustomers } from "../services/analyticsService.js";
import { createNotification } from "../services/notificationService.js";
import { logAuditEvent } from "../services/auditService.js";
import { createActivityEvent, listActivityForEntity } from "../services/activityService.js";
import { getSocketServer } from "../sockets/index.js";
import { PERMISSIONS, requirePermission } from "../utils/permissions.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, "../../uploads");

async function createAndEmitCrmNotification({ recipient, type, title, message, link }) {
  const notification = await createNotification({ recipient, type, title, message, link });
  const io = getSocketServer();
  if (notification && io && recipient) {
    io.to(`us_${recipient}`).emit("notification:new", notification);
  }
  return notification;
}

function normalizeCompanyName(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildDuplicateFilters({ email, phone, companyName, websiteId, excludeId = null }) {
  const filters = [];
  if (email) filters.push({ email: String(email).trim().toLowerCase() });
  if (phone) filters.push({ phone: String(phone).trim() });
  if (companyName) filters.push({ companyName: normalizeCompanyName(companyName) });
  const query = {
    websiteId,
    archivedAt: null
  };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  if (filters.length > 0) {
    query.$or = filters;
  }
  return query;
}

async function findDuplicateCandidates({ email, phone, companyName, websiteId, excludeId = null }) {
  if (!email && !phone && !companyName) return [];
  const matches = await Customer.find(buildDuplicateFilters({ email, phone, companyName, websiteId, excludeId }))
    .select("_id name email phone companyName pipelineStage status ownerId archivedAt")
    .populate("ownerId", "name email role")
    .limit(10);

  return matches.map((match) => {
    let score = 0;
    if (email && String(match.email || "").toLowerCase() === String(email).trim().toLowerCase()) score += 60;
    if (phone && String(match.phone || "").trim() === String(phone).trim()) score += 30;
    if (companyName && normalizeCompanyName(match.companyName) === normalizeCompanyName(companyName)) score += 20;
    return { ...match.toObject(), duplicateScore: score };
  }).sort((a, b) => b.duplicateScore - a.duplicateScore);
}

async function emitCustomerActivity({ actor, websiteId, customerId, type, summary, metadata = {} }) {
  await createActivityEvent({
    actor,
    websiteId,
    entityType: "customer",
    entityId: customerId,
    type,
    summary,
    metadata
  });
}

async function buildCustomerPayload(customerId) {
  const customer = await Customer.findById(customerId)
    .populate("ownerId", "name email role")
    .populate("assignmentHistory.ownerId", "name email role")
    .populate("assignmentHistory.assignedBy", "name email role")
    .populate("communications.sentBy", "name email role")
    .populate("communications.ticketId", "ticketId subject")
    .populate("websiteId", "websiteName domain");

  if (!customer) return null;

  const [tasks, activity] = await Promise.all([
    FollowUpTask.find({ customerId: customer._id })
      .populate("ownerId", "name email role")
      .populate("createdBy", "name email role")
      .populate("completedBy", "name email role")
      .sort({ dueAt: 1, createdAt: -1 }),
    listActivityForEntity({ entityType: "customer", entityId: customer._id, limit: 50 })
  ]);

  return { customer, tasks, activity };
}

/**
 * List all customers for the current user's websites.
 */
export const listCustomers = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_VIEW);
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const {
    status,
    search,
    websiteId,
    ownerId,
    page = 1,
    limit = 20,
    includeArchived = "false",
    view = ""
  } = req.query;

  // Safety guard: no owned websites means no data access
  if (ownedWebsiteIds.length === 0) {
    return res.json({
      customers: [],
      pagination: { total: 0, page: 1, pages: 0 },
      _debug: `No websites found for role=${req.user.role} managerId=${req.user.managerId}`
    });
  }

  const query = {};
  
  // If specific website requested, verify ownership
  if (websiteId) {
    if (!ownedWebsiteIds.map(id => id.toString()).includes(websiteId)) {
      throw new AppError("Unauthorized access to this website's CRM data", 403);
    }
    query.websiteId = websiteId;
  } else {
    // Otherwise, show all owned websites
    query.websiteId = { $in: ownedWebsiteIds };
  }

  if (status) query.status = status;
  if (ownerId) query.ownerId = ownerId;
  if (includeArchived !== "true") {
    query.archivedAt = null;
  }
  if (search) {
    query.$or = [
      { name: new RegExp(search, "i") },
      { email: new RegExp(search, "i") },
      { crn: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") },
      { companyName: new RegExp(search, "i") }
    ];
  }

  const now = new Date();
  if (view === "my_leads") {
    query.ownerId = req.user._id;
  } else if (view === "due_today") {
    query.ownerId = req.user._id;
  } else if (view === "no_follow_up") {
    query.$and = [...(query.$and || []), { nextFollowUpAt: null }];
  } else if (view === "won_this_month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    query.pipelineStage = "won";
    query.updatedAt = { $gte: startOfMonth };
  } else if (view === "archived") {
    query.archivedAt = { $ne: null };
  }

  const customers = await Customer.find(query)
    .populate("ownerId", "name email role")
    .populate("websiteId", "websiteName domain")
    .sort({ lastInteraction: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const total = await Customer.countDocuments(query);

  res.json({
    customers,
    summary: {
      myLeads: await Customer.countDocuments({ websiteId: query.websiteId, ownerId: req.user._id, archivedAt: null }),
      dueToday: await FollowUpTask.countDocuments({
        websiteId: query.websiteId,
        ownerId: req.user._id,
        status: { $in: ["open", "in_progress"] },
        dueAt: { $lte: new Date(new Date().setHours(23, 59, 59, 999)) }
      }),
      noFollowUp: await Customer.countDocuments({ websiteId: query.websiteId, archivedAt: null, nextFollowUpAt: null }),
      wonThisMonth: await Customer.countDocuments({
        websiteId: query.websiteId,
        pipelineStage: "won",
        updatedAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
      }),
      archived: await Customer.countDocuments({ websiteId: query.websiteId, archivedAt: { $ne: null } })
    },
    pagination: {
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    }
  });
});

export const createCustomer = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_CREATE);
  const {
    name,
    email,
    phone,
    companyName,
    leadSource,
    leadValue,
    expectedCloseDate,
    websiteId,
    status,
    pipelineStage,
    ownerId,
    tags
  } = req.body;
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(String(websiteId))) {
    throw new AppError("Unauthorized access to this website's CRM data", 403);
  }

  const existing = await Customer.findOne({ websiteId, email: String(email).trim().toLowerCase() });
  if (existing) {
    throw new AppError("A lead with this email already exists for the selected website", 409);
  }

  const duplicateCandidates = await findDuplicateCandidates({
    email,
    phone,
    companyName,
    websiteId
  });

  let resolvedOwnerId = null;
  if (ownerId) {
    const nextOwner = await User.findById(ownerId).select("_id managerId role websiteIds");
    if (!nextOwner) throw new AppError("Selected CRM owner was not found", 404);
    const assignedWebsiteIds = Array.isArray(nextOwner.websiteIds) ? nextOwner.websiteIds : [];
    const isLegacyTenantWide = assignedWebsiteIds.length === 0;
    const isWebsiteScoped = isLegacyTenantWide || assignedWebsiteIds.some((id) => String(id) === String(websiteId));
    const requiredManagerId = req.user.role === "admin"
      ? null
      : String(req.user.role === "client" ? req.user._id : req.user.managerId || "");
    const isSameTenant = req.user.role === "admin"
      ? true
      : String(nextOwner.managerId || "") === requiredManagerId;
    if (!isWebsiteScoped || !isSameTenant || !["sales", "manager"].includes(nextOwner.role)) {
      throw new AppError("Selected CRM owner is outside your assignment scope", 403);
    }
    resolvedOwnerId = nextOwner._id;
  }

  const customer = await Customer.create({
    crn: await generateCRN(),
    name,
    email: String(email).trim().toLowerCase(),
    phone: phone || null,
    companyName: normalizeCompanyName(companyName),
    leadSource: leadSource || "",
    leadValue: Number(leadValue || 0),
    expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null,
    websiteId,
    status: status || "lead",
    pipelineStage: pipelineStage || "new",
    ownerId: resolvedOwnerId,
    ownerAssignedAt: resolvedOwnerId ? new Date() : null,
    tags: Array.isArray(tags) ? tags : [],
    assignmentHistory: resolvedOwnerId ? [{
      ownerId: resolvedOwnerId,
      assignedBy: req.user._id,
      reason: "manual_lead_creation",
      assignedAt: new Date()
    }] : []
  });

  await incrementCustomers(websiteId);
  if (resolvedOwnerId) {
    await createAndEmitCrmNotification({
      recipient: resolvedOwnerId,
      type: "crm_lead_assigned",
      title: "New CRM lead assigned",
      message: `${name} has been assigned to you in CRM.`,
      link: "/sales"
    });
  }
  await emitCustomerActivity({
    actor: req.user,
    websiteId,
    customerId: customer._id,
    type: "created",
    summary: `CRM lead ${customer.name} was created`,
    metadata: {
      crn: customer.crn,
      ownerId: resolvedOwnerId || null,
      duplicateCandidates: duplicateCandidates.map((candidate) => ({
        _id: candidate._id,
        name: candidate.name,
        duplicateScore: candidate.duplicateScore
      }))
    }
  });
  if (duplicateCandidates.length > 0) {
    await emitCustomerActivity({
      actor: req.user,
      websiteId,
      customerId: customer._id,
      type: "duplicate_detected",
      summary: `${duplicateCandidates.length} potential CRM duplicates detected`,
      metadata: { duplicateCandidates }
    });
  }
  await logAuditEvent({
    actor: req.user,
    action: "crm.lead_created",
    entityType: "customer",
    entityId: customer._id,
    websiteId,
    metadata: {
      crn: customer.crn,
      email: customer.email,
      pipelineStage: customer.pipelineStage,
      status: customer.status,
      ownerId: resolvedOwnerId || null
    },
    ipAddress: req.ip
  });

  const created = await Customer.findById(customer._id)
    .populate("ownerId", "name email role")
    .populate("websiteId", "websiteName domain");
  res.status(201).json({ ...created.toObject(), duplicateCandidates });
});

export const archiveCustomer = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_ARCHIVE);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  customer.status = "inactive";
  customer.pipelineStage = "lost";
  customer.lastInteraction = new Date();
  customer.archivedAt = new Date();
  customer.archivedBy = req.user._id;
  customer.archiveReason = req.body?.archiveReason || "manual_archive";
  await customer.save();
  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "archived",
    summary: `${customer.name} was archived`,
    metadata: { archiveReason: customer.archiveReason }
  });
  await logAuditEvent({
    actor: req.user,
    action: "crm.lead_archived",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { crn: customer.crn },
    ipAddress: req.ip
  });

  const updated = await Customer.findById(customer._id)
    .populate("ownerId", "name email role")
    .populate("websiteId", "websiteName domain");
  res.json(updated);
});

/**
 * Get detailed customer profile with sessions and tickets.
 */
export const getCustomerProfile = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_VIEW);
  const payload = await buildCustomerPayload(req.params.id);
  const customer = payload?.customer;
    
  if (!customer) throw new AppError("Customer not found", 404);

  // Security check: must own the website
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId._id.toString())) {
    throw new AppError("Unauthorized access to this customer", 403);
  }

  // Build OR queries so we match records linked by customerId (new) OR by crn (pre-backfill)
  const sessionFilter = { websiteId: customer.websiteId._id, $or: [{ customerId: customer._id }] };
  const ticketFilter  = { websiteId: customer.websiteId._id, $or: [{ customerId: customer._id }] };
  if (customer.crn) {
    sessionFilter.$or.push({ crn: customer.crn });
    ticketFilter.$or.push({ crn: customer.crn });
  }
  // Also match by visitor schema properties (catches records linked before CRM records existed)
  if (customer.email) {
    const { Visitor } = await import("../models/Visitor.js");
    let visitors = [];

    if (customer.email.endsWith("@visitor.local")) {
      // It's an anonymous placeholder, extract the visitorId
      const extractedVisitorId = customer.email.replace("anon-", "").replace("@visitor.local", "");
      visitors = await Visitor.find({ visitorId: extractedVisitorId, websiteId: customer.websiteId }).select("_id");
    } else {
      // It's a real email, find all visitors with this email
      visitors = await Visitor.find({ email: customer.email, websiteId: customer.websiteId }).select("_id");
    }

    if (visitors.length > 0) {
      const visitorIds = visitors.map(v => v._id);
      sessionFilter.$or.push({ visitorId: { $in: visitorIds } });
      ticketFilter.$or.push({ visitorId: { $in: visitorIds } });
    }
  }

  const [sessions, tickets] = await Promise.all([
    ChatSession.find(sessionFilter)
      .populate("assignedAgent", "name email")
      .populate("websiteId", "websiteName domain")
      .sort({ createdAt: -1 })
      .limit(20),
    Ticket.find(ticketFilter)
      .populate("assignedAgent", "name email")
      .populate("websiteId", "websiteName domain")
      .populate("visitorId", "name email")
      .sort({ createdAt: -1 })
      .limit(20)
  ]);

  res.json({
    customer,
    tasks: payload.tasks,
    activity: payload.activity,
    duplicateCandidates: await findDuplicateCandidates({
      email: customer.email,
      phone: customer.phone,
      companyName: customer.companyName,
      websiteId: customer.websiteId._id,
      excludeId: customer._id
    }),
    sessions,
    tickets
  });
});

/**
 * Update customer status, tags, or info.
 */
export const updateCustomer = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_UPDATE);
  const {
    status,
    pipelineStage,
    tags,
    name,
    phone,
    companyName,
    leadSource,
    leadValue,
    expectedCloseDate,
    ownerId,
    assignmentReason,
    nextFollowUpAt,
    lastFollowUpAt
  } = req.body;
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);
  const previousState = {
    status: customer.status,
    pipelineStage: customer.pipelineStage,
    ownerId: customer.ownerId ? String(customer.ownerId) : null,
    nextFollowUpAt: customer.nextFollowUpAt,
    companyName: customer.companyName,
    leadSource: customer.leadSource,
    leadValue: customer.leadValue,
    expectedCloseDate: customer.expectedCloseDate
  };

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  if (status) customer.status = status;
  if (pipelineStage) customer.pipelineStage = pipelineStage;
  if (tags) customer.tags = tags;
  if (name) customer.name = name;
  if (phone) customer.phone = phone;
  if (companyName !== undefined) customer.companyName = normalizeCompanyName(companyName);
  if (leadSource !== undefined) customer.leadSource = leadSource || "";
  if (leadValue !== undefined) customer.leadValue = Number(leadValue || 0);
  if (expectedCloseDate !== undefined) {
    customer.expectedCloseDate = expectedCloseDate ? new Date(expectedCloseDate) : null;
  }
  if (lastFollowUpAt !== undefined) {
    customer.lastFollowUpAt = lastFollowUpAt ? new Date(lastFollowUpAt) : null;
  }
  if (nextFollowUpAt !== undefined) {
    customer.nextFollowUpAt = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
  }
  if (ownerId !== undefined) {
    if (ownerId) {
      const nextOwner = await User.findById(ownerId).select("_id managerId role websiteIds");
      if (!nextOwner) throw new AppError("Selected CRM owner was not found", 404);
      const assignedWebsiteIds = Array.isArray(nextOwner.websiteIds) ? nextOwner.websiteIds : [];
      const isLegacyTenantWide = assignedWebsiteIds.length === 0;
      const isWebsiteScoped = isLegacyTenantWide || assignedWebsiteIds.some((id) => String(id) === String(customer.websiteId));
      const requiredManagerId = req.user.role === "admin"
        ? null
        : String(req.user.role === "client" ? req.user._id : req.user.managerId || "");
      const isSameTenant = req.user.role === "admin"
        ? true
        : String(nextOwner.managerId || "") === requiredManagerId;
      if (!isWebsiteScoped || !isSameTenant || !["sales", "manager"].includes(nextOwner.role)) {
        throw new AppError("Selected CRM owner is outside your assignment scope", 403);
      }
      customer.ownerId = nextOwner._id;
      customer.ownerAssignedAt = new Date();
      if (!customer.assignmentHistory) customer.assignmentHistory = [];
      customer.assignmentHistory.unshift({
        ownerId: nextOwner._id,
        assignedBy: req.user._id,
        reason: assignmentReason || "manual_assignment",
        assignedAt: new Date()
      });
      if (String(previousState.ownerId || "") !== String(nextOwner._id)) {
        await createAndEmitCrmNotification({
          recipient: nextOwner._id,
          type: "crm_lead_assigned",
          title: "CRM owner updated",
          message: `${customer.name} is now assigned to you.`,
          link: "/sales"
        });
      }
    } else {
      customer.ownerId = null;
      customer.ownerAssignedAt = null;
      if (!customer.assignmentHistory) customer.assignmentHistory = [];
      customer.assignmentHistory.unshift({
        ownerId: null,
        assignedBy: req.user._id,
        reason: assignmentReason || "manual_unassignment",
        assignedAt: new Date()
      });
    }
  }

  await customer.save();
  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "updated",
    summary: `${customer.name} was updated`,
    metadata: {
      before: previousState,
      after: {
        status: customer.status,
        pipelineStage: customer.pipelineStage,
        ownerId: customer.ownerId ? String(customer.ownerId) : null,
        nextFollowUpAt: customer.nextFollowUpAt,
        companyName: customer.companyName,
        leadSource: customer.leadSource,
        leadValue: customer.leadValue,
        expectedCloseDate: customer.expectedCloseDate
      }
    }
  });
  await logAuditEvent({
    actor: req.user,
    action: "crm.customer_updated",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: {
      before: previousState,
      after: {
        status: customer.status,
        pipelineStage: customer.pipelineStage,
        ownerId: customer.ownerId ? String(customer.ownerId) : null,
        nextFollowUpAt: customer.nextFollowUpAt
      },
      assignmentReason: assignmentReason || ""
    },
    ipAddress: req.ip
  });
  const updated = await buildCustomerPayload(customer._id);
  res.json(updated.customer);
});

/**
 * Add an internal note to a customer profile.
 */
export const addCustomerNote = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_UPDATE);
  const { text } = req.body;
  if (!text) throw new AppError("Note text is required", 400);

  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  customer.internalNotes.unshift({
    text,
    authorName: req.user.name,
    createdAt: new Date()
  });

  await customer.save();
  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "note_added",
    summary: `A CRM note was added for ${customer.name}`,
    metadata: { note: text }
  });
  await logAuditEvent({
    actor: req.user,
    action: "crm.note_added",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { noteLength: text.length },
    ipAddress: req.ip
  });
  res.json(customer);
});

export const sendCustomerEmail = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_SEND_EMAIL);
  const { subject, body, ticketId, templateKey } = req.body;
  if (!String(subject || "").trim()) {
    throw new AppError("Subject is required", 400);
  }
  if (!String(body || "").trim()) {
    throw new AppError("Email body is required", 400);
  }
  const customer = await Customer.findById(req.params.id).populate("websiteId", "websiteName domain");
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId._id.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  if (req.user.role !== "sales") {
    throw new AppError("Only sales users can send customer emails", 403);
  }

  if (!customer.email || customer.email.endsWith("@visitor.local")) {
    throw new AppError("Customer does not have a valid email address yet", 400);
  }

  if (customer.ownerId && String(customer.ownerId) !== String(req.user._id)) {
    throw new AppError("Only the assigned sales owner can email this customer", 403);
  }

  let scopedTicketId = null;
  if (ticketId) {
    const ticket = await Ticket.findOne({
      _id: ticketId,
      websiteId: customer.websiteId._id,
      $or: [
        { customerId: customer._id },
        { crn: customer.crn }
      ]
    }).select("_id");
    if (!ticket) {
      throw new AppError("Selected ticket is not linked to this customer", 404);
    }
    scopedTicketId = ticket._id;
  }

  const { html, subject: fallbackSubject } = salesOutreachTemplate({
    customerName: customer.name,
    salesName: req.user.name,
    body,
    websiteName: customer.websiteId?.websiteName || "Support Team"
  });

  const attachmentFile = req.file || null;
  const attachmentList = attachmentFile ? [{
    filename: attachmentFile.originalname,
    path: path.join(uploadsDir, attachmentFile.filename),
    contentType: attachmentFile.mimetype
  }] : [];

  const protocol = req.protocol;
  const host = req.get("host");
  const attachmentHistory = attachmentFile ? [{
    filename: attachmentFile.originalname,
    url: `${protocol}://${host}/uploads/${attachmentFile.filename}`
  }] : [];

  const info = await sendEmail({
    to: customer.email,
    subject: subject || fallbackSubject,
    html,
    text: body,
    replyTo: req.user.email,
    attachments: attachmentList
  });

  if (!customer.communications) customer.communications = [];
  customer.communications.unshift({
    type: "email",
    direction: "outbound",
    to: customer.email,
    subject: subject || fallbackSubject,
    body,
    status: info?.messageId === "dev-mode" ? "logged" : "sent",
    sentBy: req.user._id,
    ticketId: scopedTicketId,
    providerMessageId: info?.messageId || "",
    attachments: attachmentHistory,
    sentAt: new Date()
  });
  customer.lastFollowUpAt = new Date();
  customer.lastInteraction = new Date();
  await customer.save();
  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId._id,
    customerId: customer._id,
    type: "email_sent",
    summary: `An email was sent to ${customer.email}`,
    metadata: {
      subject: subject || fallbackSubject,
      templateKey: templateKey || "",
      attachmentCount: attachmentHistory.length
    }
  });
  await logAuditEvent({
    actor: req.user,
    action: "crm.email_sent",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId._id,
    metadata: {
      to: customer.email,
      subject: subject || fallbackSubject,
      attachmentCount: attachmentHistory.length
    },
    ipAddress: req.ip
  });

  const updated = await buildCustomerPayload(customer._id);
  res.json(updated.customer);
});

export const deleteCustomer = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_DELETE, "Only client or admin can permanently delete CRM records");

  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  await logAuditEvent({
    actor: req.user,
    action: "crm.lead_deleted",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { crn: customer.crn, email: customer.email },
    ipAddress: req.ip
  });
  await Customer.deleteOne({ _id: customer._id });
  res.json({ success: true, id: customer._id, message: "Lead deleted permanently" });
});

export const getCustomerActivity = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.ACTIVITY_VIEW);
  const customer = await Customer.findById(req.params.id).select("_id websiteId");
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  const activity = await listActivityForEntity({ entityType: "customer", entityId: customer._id, limit: 100 });
  res.json(activity);
});

export const createFollowUpTask = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_MANAGE_TASKS);
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  const task = await FollowUpTask.create({
    customerId: customer._id,
    websiteId: customer.websiteId,
    ownerId: req.body.ownerId || customer.ownerId || req.user._id,
    createdBy: req.user._id,
    type: req.body.type,
    title: req.body.title,
    notes: req.body.notes || "",
    dueAt: new Date(req.body.dueAt)
  });

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "task_created",
    summary: `Follow-up task created: ${task.title}`,
    metadata: { taskId: task._id, dueAt: task.dueAt, taskType: task.type }
  });

  if (task.ownerId) {
    await createAndEmitCrmNotification({
      recipient: task.ownerId,
      type: "crm_follow_up_due",
      title: "CRM follow-up task assigned",
      message: `${customer.name}: ${task.title}`,
      link: "/client?tab=crm"
    });
  }

  res.status(201).json(
    await FollowUpTask.findById(task._id)
      .populate("ownerId", "name email role")
      .populate("createdBy", "name email role")
      .populate("completedBy", "name email role")
  );
});

export const updateFollowUpTask = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_MANAGE_TASKS);
  const task = await FollowUpTask.findById(req.params.taskId);
  if (!task) throw new AppError("Follow-up task not found", 404);

  const customer = await Customer.findById(task.customerId);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  const before = { status: task.status, dueAt: task.dueAt, ownerId: task.ownerId, title: task.title };
  if (req.body.type !== undefined) task.type = req.body.type;
  if (req.body.title !== undefined) task.title = req.body.title;
  if (req.body.notes !== undefined) task.notes = req.body.notes;
  if (req.body.ownerId !== undefined) task.ownerId = req.body.ownerId || null;
  if (req.body.dueAt !== undefined) task.dueAt = new Date(req.body.dueAt);
  if (req.body.status !== undefined) {
    task.status = req.body.status;
    if (req.body.status === "completed") {
      task.completedAt = new Date();
      task.completedBy = req.user._id;
    }
  }
  await task.save();

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: task.status === "completed" ? "task_completed" : "task_updated",
    summary: `Follow-up task updated: ${task.title}`,
    metadata: { before, after: { status: task.status, dueAt: task.dueAt, ownerId: task.ownerId, title: task.title } }
  });

  res.json(
    await FollowUpTask.findById(task._id)
      .populate("ownerId", "name email role")
      .populate("createdBy", "name email role")
      .populate("completedBy", "name email role")
  );
});

export const deleteFollowUpTask = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_MANAGE_TASKS);
  const task = await FollowUpTask.findById(req.params.taskId);
  if (!task) throw new AppError("Follow-up task not found", 404);

  const customer = await Customer.findById(task.customerId);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  await FollowUpTask.deleteOne({ _id: task._id });
  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "task_deleted",
    summary: `Follow-up task deleted: ${task.title}`,
    metadata: { taskId: task._id }
  });
  res.json({ success: true, id: task._id });
});

export const mergeCustomers = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_MERGE);
  const { primaryCustomerId, secondaryCustomerId } = req.body;
  const [primary, secondary] = await Promise.all([
    Customer.findById(primaryCustomerId),
    Customer.findById(secondaryCustomerId)
  ]);

  if (!primary || !secondary) throw new AppError("Both CRM records must exist", 404);
  if (String(primary.websiteId) !== String(secondary.websiteId)) {
    throw new AppError("CRM duplicates must belong to the same website", 400);
  }

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(primary.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  primary.phone = primary.phone || secondary.phone;
  primary.companyName = primary.companyName || secondary.companyName;
  primary.leadSource = primary.leadSource || secondary.leadSource;
  primary.leadValue = primary.leadValue || secondary.leadValue || 0;
  primary.expectedCloseDate = primary.expectedCloseDate || secondary.expectedCloseDate || null;
  primary.tags = [...new Set([...(primary.tags || []), ...(secondary.tags || [])])];
  primary.internalNotes = [...(primary.internalNotes || []), ...(secondary.internalNotes || [])];
  primary.communications = [...(primary.communications || []), ...(secondary.communications || [])];
  primary.assignmentHistory = [...(primary.assignmentHistory || []), ...(secondary.assignmentHistory || [])];
  primary.lastInteraction = new Date();
  await primary.save();

  await FollowUpTask.updateMany({ customerId: secondary._id }, { customerId: primary._id });
  await Ticket.updateMany({ customerId: secondary._id }, { customerId: primary._id, crn: primary.crn });
  await ChatSession.updateMany({ customerId: secondary._id }, { customerId: primary._id, crn: primary.crn });

  secondary.archivedAt = new Date();
  secondary.archivedBy = req.user._id;
  secondary.archiveReason = `merged_into:${primary._id}`;
  secondary.status = "inactive";
  secondary.pipelineStage = "lost";
  await secondary.save();

  await emitCustomerActivity({
    actor: req.user,
    websiteId: primary.websiteId,
    customerId: primary._id,
    type: "merged",
    summary: `${secondary.name} was merged into ${primary.name}`,
    metadata: { secondaryCustomerId: secondary._id }
  });

  res.json(await buildCustomerPayload(primary._id));
});
