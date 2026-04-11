import { Customer } from "../models/Customer.js";
import { ChatSession } from "../models/ChatSession.js";
import { Ticket } from "../models/Ticket.js";
import { User } from "../models/User.js";
import { FollowUpTask } from "../models/FollowUpTask.js";
import { Visitor } from "../models/Visitor.js";
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
import { SALES_ALLOWED_STATUS_TRANSITIONS } from "../constants/domain.js";
import { autoAssignLeadOwner } from "../services/automationService.js";
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
  const str = String(value || "").trim();
  const lower = str.toLowerCase();
  if (lower === "undefined" || lower === "null") return "";
  return lower;
}

function normalizePipelineStage(value = "") {
  const stage = String(value || "").trim().toLowerCase();
  if (["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"].includes(stage)) return stage;
  if (stage === "hold") return "contacted";
  if (stage === "proposition") return "proposal_sent";
  return "new";
}

function resolveStatusFromPipelineStage(stage) {
  const normalizedStage = normalizePipelineStage(stage);
  if (normalizedStage === "won") return "won";
  if (normalizedStage === "lost") return "lost";
  return normalizedStage;
}

function probabilityFromStage(stage) {
  const map = {
    new: 10,
    contacted: 25,
    qualified: 50,
    proposal_sent: 70,
    negotiation: 85,
    won: 100,
    lost: 0
  };
  return map[normalizePipelineStage(stage)] ?? 10;
}

async function buildChatContextFromSession(sessionId) {
  if (!sessionId) return {};

  const session = await ChatSession.findById(sessionId)
    .populate("visitorId", "visitorId country city device browser os")
    .select("visitorId currentPage firstPage");

  if (!session) return {};

  return {
    sessionId: session._id,
    pageUrl: session.currentPage || "",
    firstPage: session.firstPage || "",
    device: [
      session.visitorId?.device,
      session.visitorId?.browser,
      session.visitorId?.os
    ].filter(Boolean).join(" / "),
    location: [session.visitorId?.city, session.visitorId?.country].filter(Boolean).join(", ")
  };
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

  const visitor = await Visitor.findOne({ customerId: customer._id }).select("visitorId");

  const [tasks, activity] = await Promise.all([
    FollowUpTask.find({ customerId: customer._id })
      .populate("ownerId", "name email role")
      .populate("createdBy", "name email role")
      .populate("completedBy", "name email role")
      .sort({ dueAt: 1, createdAt: -1 })
      .limit(50),
    listActivityForEntity({ 
      entityType: "customer", 
      entityId: customer._id, 
      visitorId: visitor?.visitorId || null,
      limit: 100 
    })
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

  // Sales role can ONLY see their own assigned leads
  if (req.user.role === "sales") {
    query.ownerId = req.user._id;
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
    .populate("websiteId", "websiteName")
    .sort({ lastInteraction: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Customer.countDocuments(query);

  // Calculate dynamic heat scores for the current results
  const nowTime = new Date();
  const customersWithHeat = customers.map(c => {
    const doc = c.toObject();
    let score = 40; // baseline

    // 1. Lead Value factor (0-20 pts)
    score += Math.min(20, (doc.leadValue || 0) / 1000);

    // 2. Recency factor (0-30 pts)
    const daysSinceTouch = (nowTime - new Date(doc.lastInteraction)) / (1000 * 60 * 60 * 24);
    if (daysSinceTouch < 2) score += 30;
    else if (daysSinceTouch < 5) score += 15;
    else if (daysSinceTouch < 10) score += 5;

    // 3. Negative Decay (-3 per day, max -40)
    score -= Math.min(40, daysSinceTouch * 3);

    // 4. Priority boost
    if (doc.priority === "high") score += 10;
    
    // 5. Activity depth (Internal notes count)
    const notesCount = doc.internalNotes?.length || 0;
    score += Math.min(15, notesCount * 3);

    const pipelineProbability = Number(doc.probability ?? probabilityFromStage(doc.pipelineStage));
    score += Math.round(pipelineProbability / 10);
    if (doc.interestLevel === "hot") score += 10;
    if (doc.interestLevel === "cold") score -= 10;

    doc.heatScore = Math.max(0, Math.min(100, Math.round(score)));
    doc.probability = pipelineProbability;
    return doc;
  });

  const [myLeads, dueToday, noFollowUp, wonThisMonth, archived, lostReasons] = await Promise.all([
    Customer.countDocuments({ websiteId: query.websiteId, ownerId: req.user._id, archivedAt: null }),
    FollowUpTask.countDocuments({
      websiteId: query.websiteId,
      ownerId: req.user._id,
      status: { $in: ["open", "in_progress"] },
      dueAt: { $lte: new Date(new Date().setHours(23, 59, 59, 999)) }
    }),
    Customer.countDocuments({ websiteId: query.websiteId, archivedAt: null, nextFollowUpAt: null }),
    Customer.countDocuments({
      websiteId: query.websiteId,
      pipelineStage: "won",
      updatedAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
    }),
    Customer.countDocuments({ websiteId: query.websiteId, archivedAt: { $ne: null } })
    ,
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, archivedAt: null, pipelineStage: "lost", lostReason: { $nin: ["", null] } } },
      { $group: { _id: "$lostReason", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ])
  ]);

  const totalLeads = total;
  const totalRevenue = customersWithHeat
    .filter((customer) => customer.pipelineStage === "won")
    .reduce((sum, customer) => sum + Number(customer.leadValue || 0), 0);
  const pipelineValue = customersWithHeat
    .filter((customer) => !["won", "lost"].includes(customer.pipelineStage))
    .reduce((sum, customer) => sum + Number(customer.leadValue || 0), 0);
  const avgProbability = customersWithHeat.length
    ? Math.round(customersWithHeat.reduce((sum, customer) => sum + Number(customer.probability || 0), 0) / customersWithHeat.length)
    : 0;
  const conversionRate = totalLeads ? Number(((wonThisMonth / totalLeads) * 100).toFixed(1)) : 0;

  res.json({
    customers: customersWithHeat,
    summary: {
      myLeads,
      dueToday,
      noFollowUp,
      wonThisMonth,
      archived,
      totalLeads,
      conversionRate,
      revenue: totalRevenue,
      pipelineValue,
      avgProbability,
      lostReasons
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
    budget,
    interestLevel,
    probability,
    expectedCloseDate,
    websiteId,
    status,
    pipelineStage,
    priority,
    ownerId,
    tags,
    notes,
    sessionId
  } = req.body;
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);

  // If no websiteId provided but we have exactly one website, use that
  let resolvedWebsiteId = websiteId;
  if (!resolvedWebsiteId && ownedWebsiteIds.length === 1) {
    resolvedWebsiteId = ownedWebsiteIds[0];
  }
  if (!resolvedWebsiteId || !ownedWebsiteIds.map(id => id.toString()).includes(String(resolvedWebsiteId))) {
    throw new AppError("Unauthorized access to this website's CRM data", 403);
  }

  const existing = await Customer.findOne({ websiteId: resolvedWebsiteId, email: String(email).trim().toLowerCase() });
  if (existing) {
    throw new AppError("A lead with this email already exists for the selected website", 409);
  }

  const duplicateCandidates = await findDuplicateCandidates({
    email,
    phone,
    companyName,
    websiteId: resolvedWebsiteId
  });
  const sourceDetails = await buildChatContextFromSession(sessionId);
  const normalizedPipelineStage = normalizePipelineStage(pipelineStage || status || "new");
  const normalizedStatus = status || resolveStatusFromPipelineStage(normalizedPipelineStage);

  let resolvedOwnerId = null;
  if (ownerId) {
    const nextOwner = await User.findById(ownerId).select("_id managerId role websiteIds");
    if (!nextOwner) throw new AppError("Selected CRM owner was not found", 404);
    const assignedWebsiteIds = Array.isArray(nextOwner.websiteIds) ? nextOwner.websiteIds : [];
    const isLegacyTenantWide = assignedWebsiteIds.length === 0;
    const isWebsiteScoped = isLegacyTenantWide || assignedWebsiteIds.some((id) => String(id) === String(resolvedWebsiteId));
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

  // For sales role: auto-assign lead to themselves
  if (req.user.role === "sales" && !resolvedOwnerId) {
    resolvedOwnerId = req.user._id;
  }

  const customer = await Customer.create({
    crn: await generateCRN(),
    name,
    email: String(email).trim().toLowerCase(),
    phone: phone || null,
    companyName: normalizeCompanyName(companyName),
    leadSource: leadSource || "",
    leadValue: Number(leadValue || 0),
    budget: Number(budget || 0),
    interestLevel: interestLevel || "warm",
    probability: Number(probability ?? probabilityFromStage(normalizedPipelineStage)),
    expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null,
    websiteId: resolvedWebsiteId,
    status: normalizedStatus,
    pipelineStage: normalizedPipelineStage,
    stageEnteredAt: new Date(),
    stageHistory: [{
      fromStage: "new",
      toStage: normalizedPipelineStage,
      changedBy: req.user._id,
      changedAt: new Date(),
      reason: "lead_created"
    }],
    ownerId: resolvedOwnerId,
    ownerAssignedAt: resolvedOwnerId ? new Date() : null,
    priority: priority || "medium",
    tags: Array.isArray(tags) ? tags : [],
    sourceDetails,
    score: Math.min(100, Math.max(0,
      (sessionId ? 10 : 0) +
      (notes ? 10 : 0) +
      (priority === "high" ? 15 : priority === "medium" ? 8 : 3) +
      (interestLevel === "hot" ? 20 : interestLevel === "warm" ? 10 : 0)
    )),
    internalNotes: notes && String(notes).trim() ? [{
      text: String(notes).trim(),
      authorName: req.user.name,
      createdAt: new Date()
    }] : [],
    assignmentHistory: resolvedOwnerId ? [{
      ownerId: resolvedOwnerId,
      assignedBy: req.user._id,
      reason: "manual_lead_creation",
      assignedAt: new Date()
    }] : []
  });

  await incrementCustomers(resolvedWebsiteId);
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
    websiteId: resolvedWebsiteId,
    customerId: customer._id,
    type: "created",
    summary: `CRM lead ${customer.name} was created`,
    metadata: {
      crn: customer.crn,
      ownerId: resolvedOwnerId || null,
      pipelineStage: customer.pipelineStage,
      priority: customer.priority,
      duplicateCandidates: duplicateCandidates.map((candidate) => ({
        _id: candidate._id,
        name: candidate.name,
        duplicateScore: candidate.duplicateScore
      }))
    }
  });
  if (duplicateCandidates.length > 0) {
    const managerRecipient = req.user.role === "sales" ? (req.user.managerId || null) : null;
    if (resolvedOwnerId) {
      await createAndEmitCrmNotification({
        recipient: resolvedOwnerId,
        type: "crm_duplicate_detected",
        title: "Possible duplicate lead detected",
        message: `${duplicateCandidates.length} similar record(s) found for ${name}.`,
        link: "/sales"
      });
    } else if (managerRecipient) {
      await createAndEmitCrmNotification({
        recipient: managerRecipient,
        type: "crm_duplicate_detected",
        title: "Possible duplicate lead detected",
        message: `${duplicateCandidates.length} similar record(s) found for ${name}.`,
        link: "/client?tab=crm"
      });
    }
    await emitCustomerActivity({
      actor: req.user,
      websiteId: resolvedWebsiteId,
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
    websiteId: resolvedWebsiteId,
    metadata: {
      crn: customer.crn,
      email: customer.email,
      pipelineStage: customer.pipelineStage,
      status: customer.status,
      ownerId: resolvedOwnerId || null,
      sessionId: sessionId || null
    },
    ipAddress: req.ip
  });

  if (sessionId) {
    const linkedSession = await ChatSession.findById(sessionId).select("visitorId");
    await ChatSession.updateOne({ _id: sessionId }, { customerId: customer._id, crn: customer.crn });
    if (linkedSession?.visitorId) {
      await Visitor.updateOne({ _id: linkedSession.visitorId }, { customerId: customer._id, crn: customer.crn });
    }
  }

  if (!customer.ownerId) {
    const autoOwner = await autoAssignLeadOwner(customer, {
      assignedBy: req.user._id,
      reason: "create_customer_auto_assignment"
    });
    if (autoOwner) {
      customer.ownerId = autoOwner._id;
    }
  }

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
  const ticketFilter = { websiteId: customer.websiteId._id, $or: [{ customerId: customer._id }] };
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
    budget,
    interestLevel,
    probability,
    priority,
    lostReason,
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
    budget: customer.budget,
    interestLevel: customer.interestLevel,
    probability: customer.probability,
    priority: customer.priority,
    lostReason: customer.lostReason,
    expectedCloseDate: customer.expectedCloseDate
  };

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  // Sales: enforce status transition limits
  if (req.user.role === "sales") {
    if (status && status !== customer.status) {
      const currentStatus = customer.status || "new";
      const allowed = SALES_ALLOWED_STATUS_TRANSITIONS[currentStatus] || [currentStatus];
      if (!allowed.includes(status)) {
        throw new AppError(
          `Sales cannot change status from "${currentStatus}" to "${status}". Allowed transitions: ${allowed.join(", ")}`,
          403
        );
      }
    }
    // Sales cannot reassign leads
    if (ownerId !== undefined && String(ownerId) !== String(req.user._id)) {
      throw new AppError("Sales users cannot reassign leads to other users", 403);
    }
    // Sales cannot edit core identity fields
    if (req.body.email !== undefined) {
      throw new AppError("Sales users cannot change a lead's email address", 403);
    }
  }

  if (status) customer.status = status;
  if (pipelineStage) {
    const nextStage = normalizePipelineStage(pipelineStage);
    if (nextStage !== customer.pipelineStage) {
      if (!customer.stageHistory) customer.stageHistory = [];
      customer.stageHistory.unshift({
        fromStage: customer.pipelineStage || "new",
        toStage: nextStage,
        changedBy: req.user._id,
        changedAt: new Date(),
        durationMs: customer.stageEnteredAt ? new Date() - new Date(customer.stageEnteredAt) : 0,
        reason: assignmentReason || "manual_stage_update"
      });
      customer.pipelineStage = nextStage;
      customer.stageEnteredAt = new Date();
      customer.status = resolveStatusFromPipelineStage(nextStage);
      if (probability === undefined) {
        customer.probability = probabilityFromStage(nextStage);
      }
    }
  }
  if (tags) customer.tags = tags;
  if (name) customer.name = name;
  if (phone) customer.phone = phone;
  if (companyName !== undefined) customer.companyName = normalizeCompanyName(companyName);
  if (leadSource !== undefined) customer.leadSource = leadSource || "";
  if (leadValue !== undefined) customer.leadValue = Number(leadValue || 0);
  if (budget !== undefined) customer.budget = Number(budget || 0);
  if (interestLevel !== undefined) customer.interestLevel = interestLevel || "warm";
  if (probability !== undefined) customer.probability = Number(probability || 0);
  if (priority !== undefined) customer.priority = priority || "medium";
  if (lostReason !== undefined) customer.lostReason = lostReason || "";
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

  customer.lastActivity = new Date();
  customer.lastInteraction = new Date();

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
        budget: customer.budget,
        interestLevel: customer.interestLevel,
        probability: customer.probability,
        priority: customer.priority,
        lostReason: customer.lostReason,
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
  
  // Support both legacy "text" and unified "content"/"type" payload formats
  const { text, content, type = "note" } = req.body;
  const noteText = content || text;
  
  if (!noteText) throw new AppError("Note text or interaction content is required", 400);

  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  customer.internalNotes.unshift({
    type,
    text: noteText,
    authorId: req.user._id,
    authorName: req.user.name,
    createdAt: new Date()
  });

  customer.lastInteraction = new Date();
  customer.lastActivity = new Date();
  if (type !== "note") {
    if (!customer.communications) customer.communications = [];
    customer.communications.unshift({
      type: type === "manual_email" ? "email" : type,
      direction: "outbound",
      to: customer.email || "",
      subject: type === "manual_email" ? "Manual email log" : `${type} log`,
      body: noteText,
      status: "logged",
      sentBy: req.user._id,
      sentAt: new Date()
    });
  }
  await customer.save();

  // Map interaction types to distinct activity events for better timeline visualization
  const activityTypeMap = {
    call: "call_logged",
    meeting: "meeting_logged",
    manual_email: "manual_email_logged",
    note: "note_added"
  };

  const activityType = activityTypeMap[type] || "note_added";
  const summaryTypeLabel = type === "note" ? "CRM note" : `${type.replace("_", " ")} interaction`;

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: activityType,
    summary: `A ${summaryTypeLabel} was logged for ${customer.name}`,
    metadata: { note: noteText, interactionType: type }
  });

  await logAuditEvent({
    actor: req.user,
    action: `crm.${type}_added`,
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { noteLength: noteText.length, type },
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

  // Manager can send emails freely; sales can only email their own leads
  if (req.user.role === "sales") {
    if (customer.ownerId && String(customer.ownerId) !== String(req.user._id)) {
      throw new AppError("You can only email customers assigned to you", 403);
    }
  }

  if (!customer.email || customer.email.endsWith("@visitor.local")) {
    throw new AppError("Customer does not have a valid email address yet", 400);
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
  requirePermission(req.user, PERMISSIONS.CRM_DELETE, "Only manager, client, or admin can permanently delete CRM records");

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
    const taskOwnerIdStr = String(task.ownerId);
    const notificationLink = req.user.role === "sales" ? "/sales" : "/client?tab=crm";
    await createAndEmitCrmNotification({
      recipient: task.ownerId,
      type: "crm_follow_up_due",
      title: "CRM follow-up task assigned",
      message: `${customer.name}: ${task.title}`,
      link: notificationLink
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

/**
 * Auto-assign a lead to the sales agent with fewest active leads (round-robin).
 */
export const autoAssignCustomer = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_AUTO_ASSIGN, "Only managers can auto-assign leads");

  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map((id) => String(id)).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access", 403);
  }

  // Find all active sales agents in this tenant
  const requiredManagerId = req.user.role === "admin"
    ? null
    : (req.user.role === "client" ? req.user._id : req.user.managerId);

  const salesAgentQuery = {
    role: "sales"
  };
  if (requiredManagerId) {
    salesAgentQuery.managerId = requiredManagerId;
  }

  const salesAgents = await User.find(salesAgentQuery).select("_id name email websiteIds");

  // Filter to agents who are scoped to this website
  const eligibleAgents = salesAgents.filter(agent => {
    const assigned = Array.isArray(agent.websiteIds) ? agent.websiteIds : [];
    if (assigned.length === 0) return true; // tenant-wide agent
    return assigned.some(id => String(id) === String(customer.websiteId));
  });

  if (eligibleAgents.length === 0) {
    throw new AppError("No eligible sales agents found for this website", 404);
  }

  // Count active leads per agent using a single $group aggregation
  const eligibleAgentIds = eligibleAgents.map(a => a._id);
  const leadCountAgg = await Customer.aggregate([
    {
      $match: {
        ownerId: { $in: eligibleAgentIds },
        archivedAt: null,
        pipelineStage: { $nin: ["won", "lost"] }
      }
    },
    { $group: { _id: "$ownerId", count: { $sum: 1 } } }
  ]);

  // Build a map: agentId → leadCount (default 0)
  const countMap = new Map(leadCountAgg.map(r => [String(r._id), r.count]));
  const leadCounts = eligibleAgents.map(agent => ({
    agent,
    count: countMap.get(String(agent._id)) || 0
  }));

  // Sort by fewest leads → pick first (round-robin)
  leadCounts.sort((a, b) => a.count - b.count);
  const { agent: nextOwner } = leadCounts[0];

  const previousOwnerId = customer.ownerId ? String(customer.ownerId) : null;
  customer.ownerId = nextOwner._id;
  customer.ownerAssignedAt = new Date();
  if (!customer.assignmentHistory) customer.assignmentHistory = [];
  customer.assignmentHistory.unshift({
    ownerId: nextOwner._id,
    assignedBy: req.user._id,
    reason: "auto_assign_round_robin",
    assignedAt: new Date()
  });
  await customer.save();

  if (String(previousOwnerId || "") !== String(nextOwner._id)) {
    await createAndEmitCrmNotification({
      recipient: nextOwner._id,
      type: "crm_lead_assigned",
      title: "Lead auto-assigned to you",
      message: `${customer.name} was automatically assigned to you.`,
      link: "/sales"
    });
  }

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "auto_assigned",
    summary: `Lead auto-assigned to ${nextOwner.name} (round-robin)`,
    metadata: { assignedTo: nextOwner._id, assignedToName: nextOwner.name, reason: "round_robin" }
  });

  await logAuditEvent({
    actor: req.user,
    action: "crm.lead_auto_assigned",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { assignedTo: nextOwner._id, assignedToName: nextOwner.name },
    ipAddress: req.ip
  });

  const updated = await buildCustomerPayload(customer._id);
  res.json(updated.customer);
});

/**
 * List all follow-up tasks assigned to the current user across all customers.
 */
export const getMyFollowUpTasks = asyncHandler(async (req, res) => {
  const query = { ownerId: req.user._id };
  if (req.query.status) query.status = req.query.status;

  const tasks = await FollowUpTask.find(query)
    .populate("customerId", "name email crn status priority leadValue")
    .sort({ dueAt: 1 });

  res.json(tasks);
});

/**
 * List all internal notes from leads owned by the current user.
 */
export const getMyCustomerNotes = asyncHandler(async (req, res) => {
  const customers = await Customer.find({ 
    ownerId: req.user._id, 
    "internalNotes.0": { $exists: true } 
  }).select("name email internalNotes crn");

  const allNotes = customers.flatMap(c => 
    c.internalNotes.map(n => ({
      ...n.toObject(),
      customerName: c.name,
      customerEmail: c.email,
      customerId: c._id,
      customerCrn: c.crn
    }))
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(allNotes);
});
