import { Customer } from "../models/Customer.js";
import { ChatSession } from "../models/ChatSession.js";
import { Ticket } from "../models/Ticket.js";
import { User } from "../models/User.js";
import { FollowUpTask } from "../models/FollowUpTask.js";
import { Visitor } from "../models/Visitor.js";
import { Quotation } from "../models/Quotation.js";
import { Invoice } from "../models/Invoice.js";
import { generateQuotationPDF } from "../services/pdfService.js";
import { Analytics } from "../models/Analytics.js";
import { getOwnedWebsiteIds } from "../utils/roleUtils.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { sendEmail } from "../services/emailService.js";
import { salesOutreachTemplate } from "../utils/emailTemplates.js";
import { generateCRN } from "../services/customerService.js";
import { incrementCustomers, addWonRevenue, recordConversionTime } from "../services/analyticsService.js";
import { createNotification } from "../services/notificationService.js";
import { logAuditEvent } from "../services/auditService.js";
import { createActivityEvent, listActivityForEntity } from "../services/activityService.js";
import { getSocketServer } from "../sockets/index.js";
import { PERMISSIONS, requirePermission } from "../utils/permissions.js";
import { formatCurrency } from "../utils/formatters.js";
import {
  CRM_DEAL_STAGES,
  CRM_LEAD_STATUSES,
  CRM_LOST_REASONS,
  CRM_RECORD_TYPES,
  SALES_ALLOWED_STATUS_TRANSITIONS
} from "../constants/domain.js";
import {
  autoAssignLeadOwner,
  ensureFirstTouchTask,
  sendCrmLifecycleEmail
} from "../services/automationService.js";
import {
  calculateWinProbability,
  getNextBestAction,
  calculateChurnRisk,
  calculateHeatScore
} from "../services/intelligenceService.js";
import { calculateCustomerLTV } from "../services/revenueService.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.resolve(__dirname, "../../uploads");

const enrichmentCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getEnrichedData(doc) {
  const cacheKey = doc._id.toString();
  const cached = enrichmentCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }

  const [nba, ltv] = await Promise.all([
    getNextBestAction(doc),
    doc.status === "customer" ? calculateCustomerLTV(doc._id) : Promise.resolve(0)
  ]);

  const data = { nba, ltv };
  enrichmentCache.set(cacheKey, { timestamp: Date.now(), data });

  // Basic cleanup to prevent memory leak
  if (enrichmentCache.size > 1000) {
    const oldest = enrichmentCache.keys().next().value;
    enrichmentCache.delete(oldest);
  }

  return data;
}

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
  if (["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"].includes(stage)) return stage;
  if (stage === "hold") return "contacted";
  if (stage === "proposal_sent" || stage === "proposition") return "proposal";
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
    proposal: 70,
    negotiation: 85,
    won: 100,
    lost: 0
  };
  return map[normalizePipelineStage(stage)] ?? 10;
}

function normalizeRecordType(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (CRM_RECORD_TYPES.includes(normalized)) return normalized;
  if (normalized === "client") return "customer";
  return "lead";
}

function normalizeLeadStatus(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  const validStages = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"];
  if (validStages.includes(normalized)) return normalized;
  return "new";
}

function normalizeDealStage(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (CRM_DEAL_STAGES.includes(normalized)) return normalized;
  if (normalized === "proposal_sent") return "proposal";
  return null;
}

function deriveLifecycleFields({
  pipelineStage,
  recordType,
  leadStatus,
  dealStage
} = {}) {
  const normalizedPipelineStage = normalizePipelineStage(pipelineStage);

  // High-priority: explicit 'won' moves lead to customer
  if (normalizedPipelineStage === "won") {
    return {
      recordType: "customer",
      leadStatus: "qualified",
      dealStage: "won",
      pipelineStage: "won",
      status: "won"
    };
  }

  // Lost leads
  if (normalizedPipelineStage === "lost") {
    return {
      recordType: "deal",
      leadStatus: "qualified",
      dealStage: "lost",
      pipelineStage: "lost",
      status: "lost"
    };
  }

  // Strategy: Pipeline stage is our master indicator.
  // We promote to 'deal' for any stage that is 'qualified' or higher.
  const isDealStage = ["qualified", "proposal", "negotiation"].includes(normalizedPipelineStage);
  const isLeadStage = ["new", "contacted"].includes(normalizedPipelineStage);

  if (isDealStage) {
    return {
      recordType: "deal",
      leadStatus: "qualified",
      dealStage: normalizedPipelineStage,
      pipelineStage: normalizedPipelineStage,
      status: normalizedPipelineStage
    };
  }

  return {
    recordType: "lead",
    leadStatus: normalizedPipelineStage,
    dealStage: null,
    pipelineStage: normalizedPipelineStage,
    status: normalizedPipelineStage
  };
}

function computeLeadScore(customerLike = {}) {
  const budget = Number(customerLike.budget || 0);
  const notesCount = customerLike.internalNotes?.length || 0;
  const communicationsCount = customerLike.communications?.length || 0;
  const source = String(customerLike.leadSource || "").toLowerCase();
  const score =
    (budget >= 100000 ? 30 : budget >= 50000 ? 22 : budget > 0 ? 12 : 0) +
    (communicationsCount >= 5 ? 25 : communicationsCount >= 2 ? 15 : communicationsCount > 0 ? 8 : 0) +
    (notesCount >= 4 ? 15 : notesCount >= 2 ? 10 : notesCount > 0 ? 5 : 0) +
    (["referral", "google", "website"].includes(source) ? 15 : source ? 8 : 0) +
    (customerLike.lastFollowUpAt ? 10 : 0) +
    (customerLike.requirement ? 10 : 0) +
    (customerLike.timeline ? 10 : 0);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function categoryFromScore(score) {
  if (score >= 75) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

function expectedRevenueFromCustomer(customerLike = {}) {
  return Math.round((Number(customerLike.leadValue || 0) * Number(customerLike.probability || 0)) / 100);
}

function validateLifecycleTransition(current, next, isNew = false) {
  const currentType = normalizeRecordType(current.recordType);
  const nextType = normalizeRecordType(next.recordType);

  if (isNew && nextType === "customer") {
    throw new AppError("Cannot create a new record directly as a 'customer'. Must start as a 'lead'.", 400);
  }

  if (!isNew && currentType === "lead" && nextType === "customer") {
    throw new AppError("Lead must first be converted to a deal before becoming a customer", 400);
  }

  if (nextType === "customer" && normalizeDealStage(next.dealStage) !== "won") {
    throw new AppError("Only won deals can become customers", 400);
  }
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
    duration: session.createdAt && session.lastMessageAt
      ? `${Math.floor((new Date(session.lastMessageAt) - new Date(session.createdAt)) / 60000)} min`
      : "Unknown",
    timestamp: session.createdAt,
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
    view = "",
    leadSource,
    healthStatus,
    pipelineStage,
    range = "month"
  } = req.query;

  // Manager scope: include direct reports (agents/sales/etc) plus the manager themselves for summary metrics.
  // (Sales scope restriction is handled below.)
  let summaryOwnerIds = null;
  if (req.user.role === "manager") {
    const team = await User.find({ managerId: req.user._id }).select("_id");
    summaryOwnerIds = [req.user._id, ...team.map(t => t._id)];
  }

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
    // If no websiteId specified, narrow the scope to only websites they own
    query.websiteId = { $in: ownedWebsiteIds };
  }

  if (status) query.status = status;
  if (req.query.recordType && req.query.recordType !== "all") query.recordType = req.query.recordType;
  if (req.query.ownerId) query.ownerId = req.query.ownerId;
  if (includeArchived !== "true") query.archivedAt = null;

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
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const dueTasks = await FollowUpTask.find({
      ownerId: req.user._id,
      status: { $in: ["open", "in_progress"] },
      dueAt: { $lte: endOfToday }
    }).select("customerId");
    query._id = { $in: dueTasks.map(t => t.customerId) };
  } else if (view === "no_follow_up") {
    query.nextFollowUpAt = null;
  } else if (view === "won_this_month") {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    query.pipelineStage = "won";
    query.updatedAt = { $gte: startOfMonth };
  } else if (view === "archived") {
    query.archivedAt = { $ne: null };
  }

  // Drill-down Filters
  if (leadSource) query.leadSource = leadSource;
  if (pipelineStage) query.pipelineStage = pipelineStage;
  if (healthStatus === "overdue") {
    query.nextFollowUpAt = { $lt: now };
  } else if (healthStatus === "stale") {
    query.updatedAt = { $lt: new Date(now - 3 * 24 * 60 * 60 * 1000) };
  } else if (healthStatus === "critical") {
    query.updatedAt = { $lt: new Date(now - 7 * 24 * 60 * 60 * 1000) };
  }

  const customers = await Customer.find(query)
    .populate("ownerId", "name email role")
    .populate("websiteId", "websiteName")
    .sort({ lastInteraction: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Customer.countDocuments(query);

  // Calculate dynamic data for the current results
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const customersWithHeat = customers.map(c => {
    const doc = c.toObject();
    let score = 40; // baseline

    // Heat calculation logic
    score += Math.min(20, (doc.leadValue || 0) / 1000);
    const daysSinceTouch = (now - new Date(doc.lastInteraction)) / (1000 * 60 * 60 * 24);
    if (daysSinceTouch < 2) score += 30;
    else if (daysSinceTouch < 5) score += 15;
    else if (daysSinceTouch < 10) score += 5;
    score -= Math.min(40, daysSinceTouch * 3);
    if (doc.priority === "high") score += 10;
    const nC = doc.internalNotes?.length || 0;
    score += Math.min(15, nC * 3);

    const computedLeadScore = computeLeadScore(doc);
    doc.score = computedLeadScore;
    doc.leadCategory = doc.leadCategory || categoryFromScore(computedLeadScore);
    doc.expectedRevenue = expectedRevenueFromCustomer(doc);

    // Tier 2: Intelligence Enrichment
    doc.heatScore = calculateHeatScore(doc); // Automated Heat Score
    doc.probability = calculateWinProbability(doc);

    // Churn Risk for customers
    if (doc.status === "customer") {
      doc.churnRisk = calculateChurnRisk(doc);
    }

    return doc;
  });

  // Enrichment for individual results (NBA and LTV are async/heavy, so we do them on the enriched slice)
  const finalCustomers = await Promise.all(customersWithHeat.map(async (doc) => {
    const enriched = await getEnrichedData(doc);

    doc.nbaRecommendation = enriched.nba ? `${enriched.nba.action}: ${enriched.nba.recommendation}` : "";
    doc.nbaMetadata = enriched.nba; // Full object for UI icons/priority

    if (doc.status === "customer") {
      doc.ltv = enriched.ltv;
    }

    return doc;
  }));

  // Calculate summary statistics accurately across the entire website/agent scope (not just current page)
  const summaryMatch = { websiteId: query.websiteId, archivedAt: null };

  if (range === "today") {
    summaryMatch.createdAt = { $gte: new Date(new Date().setHours(0, 0, 0, 0)) };
  } else if (range === "week") {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    summaryMatch.createdAt = { $gte: weekAgo };
  } else if (range === "month") {
    summaryMatch.createdAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
  }

  const [summaryAgg] = await Customer.aggregate([
    { $match: summaryMatch },
    {
      $group: {
        _id: null,
        totalRevenue: {
          $sum: { $cond: [{ $eq: ["$pipelineStage", "won"] }, "$leadValue", 0] }
        },
        pipelineValue: {
          $sum: { $cond: [{ $not: [{ $in: ["$pipelineStage", ["won", "lost"]] }] }, "$leadValue", 0] }
        },
        weightedRevenue: {
          $sum: {
            $cond: [
              { $not: [{ $in: ["$pipelineStage", ["won", "lost"]] }] },
              {
                $multiply: [
                  { $ifNull: ["$leadValue", 0] },
                  { $divide: [{ $convert: { input: { $ifNull: ["$probability", 10] }, to: "double" } }, 100] }
                ]
              },
              0
            ]
          }
        },
        avgProbability: { $avg: "$probability" },
        aging_0_2: {
          $sum: { $cond: [{ $gte: ["$updatedAt", new Date(now - 2 * 24 * 60 * 60 * 1000)] }, 1, 0] }
        },
        aging_3_7: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $lt: ["$updatedAt", new Date(now - 2 * 24 * 60 * 60 * 1000)] },
                  { $gte: ["$updatedAt", new Date(now - 7 * 24 * 60 * 60 * 1000)] }
                ]
              },
              1,
              0
            ]
          }
        },
        aging_7_plus: {
          $sum: { $cond: [{ $lt: ["$updatedAt", new Date(now - 7 * 24 * 60 * 60 * 1000)] }, 1, 0] }
        },
        totalLTV: {
          $sum: { $cond: [{ $eq: ["$status", "customer"] }, "$leadValue", 0] }
        },
        customerCount: {
          $sum: { $cond: [{ $eq: ["$status", "customer"] }, 1, 0] }
        }
      }
    }
  ]);

  const [myLeads, dueToday, noFollowUp, wonThisMonth, archived, lostReasons, stageBreakdown, agents, analytics, leadsBySource, followUpHealth, agentTasks, lostByStageRaw, leadsPerDay, prevMonthStats, lostByStage, dropOffByCategory] = await Promise.all([
    Customer.countDocuments({
      websiteId: query.websiteId,
      ...(summaryOwnerIds ? { ownerId: { $in: summaryOwnerIds } } : { ownerId: req.user._id }),
      archivedAt: null
    }),
    FollowUpTask.countDocuments({
      websiteId: query.websiteId,
      ...(summaryOwnerIds ? { ownerId: { $in: summaryOwnerIds } } : { ownerId: req.user._id }),
      status: { $in: ["open", "in_progress"] },
      dueAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lte: new Date(new Date().setHours(23, 59, 59, 999))
      }
    }),
    Customer.countDocuments({ websiteId: query.websiteId, archivedAt: null, nextFollowUpAt: null }),
    Customer.countDocuments({
      websiteId: query.websiteId,
      pipelineStage: "won",
      updatedAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) }
    }),
    Customer.countDocuments({ websiteId: query.websiteId, archivedAt: { $ne: null } }),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, archivedAt: null, pipelineStage: "lost", lostReason: { $nin: ["", null] } } },
      { $group: { _id: "$lostReason", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),
    Customer.aggregate([
      { $match: summaryMatch },
      { $group: { _id: "$pipelineStage", count: { $sum: 1 }, totalValue: { $sum: "$leadValue" } } }, // Fixing field name to totalValue for UI
      { $sort: { count: -1 } }
    ]),
    Customer.aggregate([
      {
        $match: {
          websiteId: query.websiteId,
          pipelineStage: "won",
          ownerId: summaryOwnerIds ? { $in: summaryOwnerIds } : { $ne: null }
        }
      },
      {
        $group: {
          _id: "$ownerId",
          deals: { $sum: 1 },
          revenue: { $sum: "$leadValue" }
        }
      },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "agent" } },
      { $unwind: "$agent" },
      { $project: { name: "$agent.name", email: "$agent.email", deals: 1, revenue: 1 } },
      { $sort: { revenue: -1 } },
      { $limit: 10 }
    ]),
    Analytics.findOne({ websiteId: query.websiteId }),
    Customer.aggregate([
      { $match: { ...summaryMatch, leadSource: { $ne: null } } },
      { $group: { _id: "$leadSource", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    FollowUpTask.aggregate([
      { $match: { websiteId: query.websiteId } },
      {
        $group: {
          _id: null,
          overdue: { $sum: { $cond: [{ $and: [{ $lt: ["$dueAt", now] }, { $eq: ["$status", "open"] }] }, 1, 0] } },
          completedToday: { $sum: { $cond: [{ $gte: ["$completedAt", new Date(new Date().setHours(0, 0, 0, 0))] }, 1, 0] } },
          totalOpen: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } }
        }
      }
    ]),
    FollowUpTask.aggregate([
      {
        $match: {
          websiteId: query.websiteId,
          status: "completed",
          ...(summaryOwnerIds ? { ownerId: { $in: summaryOwnerIds } } : {})
        }
      },
      { $group: { _id: "$ownerId", count: { $sum: 1 } } }
    ]),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, pipelineStage: "lost" } },
      { $group: { _id: "$status", count: { $sum: 1 }, sources: { $push: "$leadSource" } } } // Note: we'll use more granular aggregation for 'dropped at stage'
    ]),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, createdAt: { $gte: sevenDaysAgo } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id": 1 } }
    ]),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, pipelineStage: "won", updatedAt: { $gte: lastMonthStart, $lte: lastMonthEnd } } },
      { $group: { _id: null, revenue: { $sum: "$leadValue" }, deals: { $sum: 1 } } }
    ]),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, pipelineStage: "lost", archivedAt: null } },
      {
        $project: {
          lastStage: {
            $arrayElemAt: [
              {
                $filter: {
                  input: "$stageHistory",
                  as: "sh",
                  cond: { $ne: ["$$sh.stage", "lost"] }
                }
              },
              -1
            ]
          }
        }
      },
      { $group: { _id: null, stages: { $push: { $ifNull: ["$lastStage.stage", "unknown"] } } } }
    ]),
    Customer.aggregate([
      { $match: { websiteId: query.websiteId, pipelineStage: "lost" } },
      { $group: { _id: "$leadCategory", count: { $sum: 1 } } } // Bonus drop-off insight
    ])
  ]);

  // Enrich agents with task counts
  const agentTaskMap = (agentTasks || []).reduce((acc, t) => {
    if (t._id) acc[String(t._id)] = t.count;
    return acc;
  }, {});

  const enrichedAgents = agents.map(a => ({
    ...a,
    tasks: a._id ? (agentTaskMap[String(a._id)] || 0) : 0
  }));

  res.json({
    customers: finalCustomers,
    summary: {
      myLeads,
      dueToday,
      noFollowUp,
      wonThisMonth,
      archived,
      totalLeads: total,
      conversionRate: total ? Number(((wonThisMonth / total) * 100).toFixed(1)) : 0,
      revenue: summaryAgg?.totalRevenue || 0,
      pipelineValue: summaryAgg?.pipelineValue || 0,
      weightedRevenue: Math.round(summaryAgg?.weightedRevenue || 0),
      avgProbability: Math.round(summaryAgg?.avgProbability || 0),
      aging: {
        recent: summaryAgg?.aging_0_2 || 0,
        stale: summaryAgg?.aging_3_7 || 0,
        dormant: summaryAgg?.aging_7_plus || 0
      },
      ltv: summaryAgg?.customerCount ? Math.round(summaryAgg.totalLTV / summaryAgg.customerCount) : 0,
      cac: analytics?.cac || 0,
      agents: enrichedAgents,
      leadsBySource,
      leadsPerDay,
      followUpHealth: followUpHealth[0] || { overdue: 0, completedToday: 0, totalOpen: 0 },
      lostReasons,
      lostByStage,
      comparison: {
        prevMonthRevenue: prevMonthStats[0]?.revenue || 0,
        prevMonthDeals: prevMonthStats[0]?.deals || 0
      },
      stageBreakdown
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
    recordType,
    leadStatus,
    dealStage,
    leadSource,
    leadValue,
    budget,
    requirement,
    timeline,
    interestLevel,
    leadCategory,
    probability,
    expectedCloseDate,
    decisionMaker,
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
  const lifecycle = deriveLifecycleFields({
    pipelineStage: pipelineStage || status || leadStatus || dealStage || "new",
    recordType,
    leadStatus,
    dealStage
  });
  validateLifecycleTransition(
    { recordType: "lead", leadStatus: lifecycle.leadStatus, dealStage: null },
    lifecycle,
    true
  );

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

  /*
  if (lifecycle.recordType !== "lead") {
    if (!requirement || !timeline || budget === undefined || budget === null || !leadSource) {
      throw new AppError("Qualified records require budget, requirement, timeline, and source", 400);
    }
  }
  if (["deal", "customer"].includes(lifecycle.recordType)) {
    if (!Number(leadValue || 0)) {
      throw new AppError("No deal without value", 400);
    }
    if (!decisionMaker) {
      throw new AppError("Decision maker is required for deals", 400);
    }
  }
  */
  if (lifecycle.dealStage === "lost" && !req.body.lostReason) {
    throw new AppError("Lost deals require a lost reason", 400);
  }

  const computedScore = computeLeadScore({
    budget,
    leadSource,
    requirement,
    timeline,
    lastFollowUpAt: null,
    communications: [],
    internalNotes: notes ? [{}] : []
  });

  const customer = await Customer.create({
    crn: await generateCRN(),
    name,
    email: String(email).trim().toLowerCase(),
    phone: phone || null,
    companyName: normalizeCompanyName(companyName),
    recordType: lifecycle.recordType,
    leadStatus: lifecycle.leadStatus,
    dealStage: lifecycle.dealStage,
    leadSource: leadSource || "",
    leadValue: Number(leadValue || 0),
    budget: Number(budget || 0),
    requirement: String(requirement || "").trim(),
    timeline: String(timeline || "").trim(),
    interestLevel: interestLevel || "warm",
    leadCategory: leadCategory || categoryFromScore(computedScore),
    probability: Number(probability ?? probabilityFromStage(lifecycle.pipelineStage)),
    expectedCloseDate: expectedCloseDate ? new Date(expectedCloseDate) : null,
    decisionMaker: String(decisionMaker || "").trim(),
    websiteId: resolvedWebsiteId,
    status: lifecycle.status,
    pipelineStage: lifecycle.pipelineStage,
    stageEnteredAt: new Date(),
    stageHistory: [{
      fromStage: "new",
      toStage: normalizePipelineStage(lifecycle.pipelineStage),
      changedBy: req.user._id,
      changedAt: new Date(),
      reason: "lead_created"
    }],
    ownerId: resolvedOwnerId,
    ownerAssignedAt: resolvedOwnerId ? new Date() : null,
    priority: priority || "medium",
    tags: Array.isArray(tags) ? tags : [],
    sourceDetails,
    score: computedScore,
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

  // Phase 3 & 11: Automation on creation/assignment
  if (resolvedOwnerId) {
    await ensureFirstTouchTask(customer, resolvedOwnerId);
  }
  await sendCrmLifecycleEmail(customer, "welcome");

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
      recordType: customer.recordType,
      leadStatus: customer.leadStatus,
      dealStage: customer.dealStage,
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
      recordType: customer.recordType,
      ownerId: resolvedOwnerId || null,
      sessionId: sessionId || null
    },
    ipAddress: req.ip,
    after: customer
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
  customer.recordType = customer.recordType === "customer" ? "customer" : "deal";
  customer.leadStatus = customer.leadStatus || "qualified";
  customer.dealStage = "lost";
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
    ipAddress: req.ip,
    before: snapshotBefore,
    after: customer
  });

  const updated = await Customer.findById(customer._id)
    .populate("ownerId", "name email role")
    .populate("websiteId", "websiteName domain");
  res.json(updated);
});

/**
 * Post-win workflow: mark a CRM record as won, create onboarding tasks, draft a quotation,
 * send lifecycle email/notification, record activity and audit event.
 */
export const postWin = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_UPDATE);
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const id = req.params.id;
  const customer = await Customer.findById(id);
  if (!customer) throw new AppError("CRM record not found", 404);
  if (!ownedWebsiteIds.map(String).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access to this website's CRM data", 403);
  }

  if (customer.isLocked) {
    throw new AppError("This lead is locked and cannot be modified.", 403);
  }

  // Idempotent: if already won, return current state
  if (String(customer.pipelineStage) === "won" || String(customer.status) === "won") {
    return res.json(await buildCustomerPayload(customer._id));
  }

  const prevStage = customer.pipelineStage || "new";
  customer.pipelineStage = "won";
  customer.status = "won";
  customer.dealStage = "won";
  customer.recordType = "customer";
  customer.probability = 100;
  customer.stageEnteredAt = new Date();
  if (!Array.isArray(customer.stageHistory)) customer.stageHistory = [];
  customer.stageHistory.unshift({
    fromStage: prevStage,
    toStage: "won",
    changedBy: req.user._id,
    changedAt: new Date(),
    reason: "deal_won"
  });

  await customer.save();

  // Create a draft quotation
  let quotation = null;
  try {
    quotation = await Quotation.create({
      customerId: customer._id,
      websiteId: customer.websiteId,
      createdBy: req.user._id,
      status: "draft",
      items: [],
      amount: Number(customer.leadValue || 0),
      currency: "INR",
      notes: "Auto-draft generated when deal marked won"
    });
  } catch (err) {
    // non-fatal: continue even if quotation fails
    console.error("Quotation create failed", err);
  }

  // Create onboarding follow-up tasks
  const owner = customer.ownerId || req.user._id;
  const onboardingTasks = [
    { title: `Welcome email to ${customer.name}`, days: 0 },
    { title: `Schedule onboarding call with ${customer.name}`, days: 1 },
    { title: `Create customer account for ${customer.name}`, days: 2 },
    { title: `Provision service / setup for ${customer.name}`, days: 3 }
  ];

  const createdTasks = [];
  for (const t of onboardingTasks) {
    try {
      const dueAt = new Date();
      dueAt.setDate(dueAt.getDate() + (t.days || 0));
      const task = await FollowUpTask.create({
        websiteId: customer.websiteId,
        customerId: customer._id,
        ownerId: owner,
        title: t.title,
        description: t.title,
        priority: "high",
        dueAt,
        type: "onboarding"
      });
      createdTasks.push(task);
    } catch (err) {
      console.error("Failed to create onboarding task", err);
    }
  }

  // Send lifecycle email to customer and notify owner
  try {
    await sendCrmLifecycleEmail(customer, "welcome");
  } catch (err) {
    console.error("sendCrmLifecycleEmail failed", err);
  }

  if (owner) {
    await createAndEmitCrmNotification({
      recipient: owner,
      type: "crm_deal_won",
      title: "Deal won",
      message: `${customer.name} marked as won`,
      link: `/crm/${customer._id}`
    });
  }

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "deal_won",
    summary: `Deal won for ${customer.name}`,
    metadata: { prevStage }
  });

  await logAuditEvent({
    actor: req.user,
    action: "crm.deal_won",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { prevStage, quotationId: quotation?._id || null },
    ipAddress: req.ip
  });

  // update analytics snapshot if available
  try {
    await incrementCustomers(customer.websiteId);
  } catch (err) {
    console.error("incrementCustomers failed", err);
  }
  try {
    // record revenue and conversion time for analytics
    await addWonRevenue(customer.websiteId, customer.leadValue || 0);
    const createdAt = customer.createdAt ? new Date(customer.createdAt) : new Date();
    const conversionSeconds = Math.round((Date.now() - createdAt.getTime()) / 1000);
    await recordConversionTime(customer.websiteId, conversionSeconds);
  } catch (err) {
    console.error("analytics post-win update failed", err);
  }

  const payload = await buildCustomerPayload(customer._id);
  res.json({ customer: payload.customer, tasks: createdTasks, quotation });
});

/**
 * Reports: aggregated CRM metrics for a website or range
 */
export const getCrmReports = asyncHandler(async (req, res) => {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const { websiteId, startDate, endDate } = req.query;
  const match = { websiteId: { $in: ownedWebsiteIds }, pipelineStage: "won" };
  if (websiteId) {
    if (!ownedWebsiteIds.map(String).includes(String(websiteId))) throw new AppError("Access denied", 403);
    match.websiteId = websiteId;
  }
  const start = startDate ? new Date(startDate) : new Date(0);
  const end = endDate ? new Date(endDate) : new Date();
  match.updatedAt = { $gte: start, $lte: end };

  const agg = await Customer.aggregate([
    { $match: match },
    { $project: { leadValue: 1, createdAt: 1, stageEnteredAt: 1 } },
    { $group: { _id: null, totalRevenue: { $sum: "$leadValue" }, deals: { $sum: 1 }, avgConversionSeconds: { $avg: { $divide: [{ $subtract: ["$stageEnteredAt", "$createdAt"] }, 1000] } } } }
  ]);

  const row = agg[0] || { totalRevenue: 0, deals: 0, avgConversionSeconds: 0 };
  res.json({ totalRevenue: row.totalRevenue || 0, deals: row.deals || 0, avgConversionSeconds: Math.round(row.avgConversionSeconds || 0) });
});

/**
 * Time-series of won revenue (by day)
 * query: websiteId, days (default 30)
 */
export const getWonRevenueTimeseries = asyncHandler(async (req, res) => {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const { websiteId, days = 30 } = req.query;
  const dayCount = Math.max(1, Math.min(365, parseInt(days, 10) || 30));

  if (websiteId) {
    if (!ownedWebsiteIds.map(String).includes(String(websiteId))) throw new AppError("Access denied", 403);
  }

  // Build date range
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(end.getDate() - (dayCount - 1));
  start.setHours(0, 0, 0, 0);

  const match = {
    websiteId: websiteId ? websiteId : { $in: ownedWebsiteIds },
    status: "paid",
    issuedAt: { $gte: start, $lte: end }
  };

  const agg = await Invoice.aggregate([
    { $match: match },
    {
      $project: {
        issuedAt: 1,
        total: 1
      }
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$issuedAt" } },
        revenue: { $sum: "$total" }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  // Build map
  const map = {};
  agg.forEach((r) => { map[r._id] = r.revenue || 0; });

  const series = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().split("T")[0];
    series.push({ date: key, revenue: map[key] || 0 });
  }

  const totalRevenue = series.reduce((s, r) => s + (Number(r.revenue) || 0), 0);
  res.json({ series, totalRevenue });
});

/**
 * List invoices for a given customer (CRM access required)
 */
export const getCustomerInvoices = asyncHandler(async (req, res) => {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const { customerId } = req.params;
  const customer = await Customer.findById(customerId).select("websiteId");
  if (!customer) throw new AppError("Customer not found", 404);
  if (!ownedWebsiteIds.map(String).includes(String(customer.websiteId))) throw new AppError("Access denied", 403);

  const invoices = await Invoice.find({ customerId }).sort({ issuedAt: -1 }).limit(100);
  res.json(invoices);
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
    recordType,
    leadStatus,
    dealStage,
    tags,
    name,
    phone,
    companyName,
    leadSource,
    leadValue,
    budget,
    requirement,
    timeline,
    interestLevel,
    leadCategory,
    probability,
    priority,
    lostReason,
    expectedCloseDate,
    decisionMaker,
    ownerId,
    assignmentReason,
    nextFollowUpAt,
    lastFollowUpAt
  } = req.body;
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw new AppError("Customer not found", 404);
  const previousState = {
    recordType: customer.recordType,
    leadStatus: customer.leadStatus,
    dealStage: customer.dealStage,
    status: customer.status,
    pipelineStage: customer.pipelineStage,
    ownerId: customer.ownerId ? String(customer.ownerId) : null,
    nextFollowUpAt: customer.nextFollowUpAt,
    companyName: customer.companyName,
    leadSource: customer.leadSource,
    leadValue: customer.leadValue,
    budget: customer.budget,
    requirement: customer.requirement,
    timeline: customer.timeline,
    interestLevel: customer.interestLevel,
    leadCategory: customer.leadCategory,
    probability: customer.probability,
    priority: customer.priority,
    lostReason: customer.lostReason,
    expectedCloseDate: customer.expectedCloseDate,
    decisionMaker: customer.decisionMaker
  };
  const snapshotBefore = customer.toObject();

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(id => id.toString()).includes(customer.websiteId.toString())) {
    throw new AppError("Unauthorized access", 403);
  }

  if (customer.isLocked) {
    throw new AppError("This lead is locked and cannot be modified.", 403);
  }

  // Sales: enforce status transition limits
  if (req.user.role === "sales") {
    const requestedStatus = dealStage || leadStatus || status;
    if (requestedStatus && requestedStatus !== customer.status) {
      const currentStatus = customer.dealStage || customer.leadStatus || customer.status || "new";
      const allowed = SALES_ALLOWED_STATUS_TRANSITIONS[currentStatus] || [currentStatus];
      if (!allowed.includes(requestedStatus)) {
        throw new AppError(
          `Sales cannot change status from "${currentStatus}" to "${requestedStatus}". Allowed transitions: ${allowed.join(", ")}`,
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

  const nextLifecycle = deriveLifecycleFields({
    pipelineStage: pipelineStage || status || leadStatus || dealStage || customer.pipelineStage,
    recordType: recordType || customer.recordType,
    leadStatus: leadStatus || customer.leadStatus,
    dealStage: dealStage || customer.dealStage
  });
  validateLifecycleTransition(previousState, nextLifecycle);

  if (tags) customer.tags = tags;
  if (name) customer.name = name;
  if (phone) customer.phone = phone;
  if (companyName !== undefined) customer.companyName = normalizeCompanyName(companyName);
  if (leadSource !== undefined) customer.leadSource = leadSource || "";
  if (leadValue !== undefined) customer.leadValue = Number(leadValue || 0);
  if (budget !== undefined) customer.budget = Number(budget || 0);
  if (requirement !== undefined) customer.requirement = String(requirement || "").trim();
  if (timeline !== undefined) customer.timeline = String(timeline || "").trim();
  if (interestLevel !== undefined) customer.interestLevel = interestLevel || "warm";
  if (probability !== undefined) customer.probability = Number(probability || 0);
  if (priority !== undefined) customer.priority = priority || "medium";
  if (lostReason !== undefined) customer.lostReason = lostReason || "";
  if (expectedCloseDate !== undefined) {
    customer.expectedCloseDate = expectedCloseDate ? new Date(expectedCloseDate) : null;
  }
  if (decisionMaker !== undefined) customer.decisionMaker = String(decisionMaker || "").trim();
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

      // Phase 3 & 11: Automation on reassignment
      await ensureFirstTouchTask(customer, nextOwner._id);

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

  if (nextLifecycle.recordType !== customer.recordType || nextLifecycle.pipelineStage !== customer.pipelineStage) {
    if (!customer.stageHistory) customer.stageHistory = [];
    customer.stageHistory.unshift({
      fromStage: normalizePipelineStage(customer.pipelineStage || "new"),
      toStage: normalizePipelineStage(nextLifecycle.pipelineStage),
      changedBy: req.user._id,
      changedAt: new Date(),
      durationMs: customer.stageEnteredAt ? new Date() - new Date(customer.stageEnteredAt) : 0,
      reason: assignmentReason || "manual_stage_update"
    });
    customer.stageEnteredAt = new Date();
  }

  customer.recordType = nextLifecycle.recordType;
  customer.leadStatus = nextLifecycle.leadStatus;
  customer.dealStage = nextLifecycle.dealStage;
  customer.pipelineStage = nextLifecycle.pipelineStage;
  customer.status = nextLifecycle.status;

  // Validation relaxed to allow fluid pipeline movement
  if (customer.dealStage === "lost" && !customer.lostReason) {
    throw new AppError("Lost deals require a lost reason", 400);
  }
  if (customer.recordType === "customer" && customer.pipelineStage !== "won") {
    throw new AppError("Customers can only be created from won deals", 400);
  }

  if (leadCategory !== undefined) {
    customer.leadCategory = leadCategory || "warm";
  } else {
    customer.score = computeLeadScore(customer);
    customer.leadCategory = categoryFromScore(customer.score);
  }
  if (probability === undefined) {
    customer.probability = probabilityFromStage(customer.pipelineStage);
  }

  customer.lastActivity = new Date();
  customer.lastInteraction = new Date();

  // Track score history and detect spikes
  const currentScore = customer.score || 0;
  if (!customer.scoreHistory) customer.scoreHistory = [];
  
  // Find a score from approx 24 hours ago
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oldScoreEntry = [...customer.scoreHistory]
    .reverse()
    .find(h => h.recordedAt <= oneDayAgo);
  
  if (oldScoreEntry && (currentScore - oldScoreEntry.score) >= 20) {
    // Spike detected!
    const io = getSocketServer();
    if (io && customer.ownerId) {
      io.to(`us_${customer.ownerId}`).emit("crm:intent-alert", {
        leadId: customer._id,
        name: customer.name,
        spike: currentScore - oldScoreEntry.score,
        currentScore
      });
      
      await createNotification({
        recipient: customer.ownerId,
        type: "crm_follow_up_due", // Reusing type for UI icon
        title: "🔥 High Intent Spike detected",
        message: `${customer.name}'s heat score jumped by ${currentScore - oldScoreEntry.score} points! Intervene now to close the deal.`,
        link: "/sales"
      });
    }
  }

  // Only record history if score changed or it's been more than 4 hours
  const lastEntry = customer.scoreHistory[0];
  if (!lastEntry || lastEntry.score !== currentScore || (Date.now() - new Date(lastEntry.recordedAt)) > 4 * 60 * 60 * 1000) {
    customer.scoreHistory.unshift({ score: currentScore, recordedAt: new Date() });
    // Keep history manageable
    if (customer.scoreHistory.length > 30) customer.scoreHistory.pop();
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
        recordType: customer.recordType,
        leadStatus: customer.leadStatus,
        dealStage: customer.dealStage,
        status: customer.status,
        pipelineStage: customer.pipelineStage,
        ownerId: customer.ownerId ? String(customer.ownerId) : null,
        nextFollowUpAt: customer.nextFollowUpAt,
        companyName: customer.companyName,
        leadSource: customer.leadSource,
        leadValue: customer.leadValue,
        budget: customer.budget,
        requirement: customer.requirement,
        timeline: customer.timeline,
        interestLevel: customer.interestLevel,
        leadCategory: customer.leadCategory,
        probability: customer.probability,
        priority: customer.priority,
        lostReason: customer.lostReason,
        expectedCloseDate: customer.expectedCloseDate,
        decisionMaker: customer.decisionMaker
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
        recordType: customer.recordType,
        leadStatus: customer.leadStatus,
        dealStage: customer.dealStage,
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

/**
 * Creates a new digital quotation for a customer.
 */
export const createQuotation = asyncHandler(async (req, res) => {
  const { customerId, websiteId, items, subtotal, tax, total, currency, notes, terms, validUntil } = req.body;

  if (!customerId || !websiteId || !items || !total) {
    throw new AppError("Missing required quotation fields.", 400);
  }

  const isManager = ["admin", "client", "manager"].includes(req.user.role);
  const requiresApproval = total > 50000 && !isManager;
  const status = requiresApproval ? "pending_approval" : "sent";

  const quotationId = `QT-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;

  const quotation = await Quotation.create({
    quotationId,
    customerId,
    websiteId,
    ownerId: req.user._id,
    items,
    subtotal,
    tax,
    total,
    currency: currency || "INR",
    notes,
    terms,
    validUntil: validUntil || new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // Default 15 days
    status,
    tracking: [{ event: status, occuredAt: new Date(), ip: req.ip }]
  });

  if (requiresApproval) {
    // Notify manager if available
    const managerRecipient = req.user.managerId || null;
    if (managerRecipient) {
      await createAndEmitCrmNotification({
        recipient: managerRecipient,
        type: "crm_approval_required",
        title: "Deal Approval Required",
        message: `A high-value quotation (${formatCurrency(total)}) requires your authorization.`,
        link: `/client?tab=crm&leadId=${customerId}`
      });
    }
  }

  await createActivityEvent({
    actor: req.user,
    websiteId,
    entityType: "customer",
    entityId: customerId,
    type: "quote_sent",
    summary: `Digital quotation ${quotationId} for ${total} sent to customer.`,
    metadata: { quotationId, total }
  });

  res.status(201).json(quotation);
});

/**
 * Create a Stripe PaymentIntent for a quotation
 */
export const createQuotationPayment = asyncHandler(async (req, res) => {
  const stripeKey = env.stripeSecretKey;
  if (!stripeKey) throw new AppError("Stripe not configured", 500);
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeKey);

  const { id } = req.params;
  const quotation = await Quotation.findById(id);
  if (!quotation) throw new AppError("Quotation not found", 404);

  const amount = Math.round(Number(quotation.total || 0) * 100); // INR -> paise
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: (quotation.currency || 'INR').toLowerCase(),
    metadata: { quotationId: quotation.quotationId, quotationDbId: String(quotation._id) }
  });

  res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
});

/**
 * List all quotations for a specific customer.
 */
export const getCustomerQuotations = asyncHandler(async (req, res) => {
  const { customerId } = req.params;
  const quotes = await Quotation.find({ customerId }).sort({ createdAt: -1 });
  res.json(quotes);
});

/**
 * Update the status of a quotation (e.g., accepted, rejected).
 */
export const updateQuotationStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, reason } = req.body;

  const quotation = await Quotation.findById(id);
  if (!quotation) throw new AppError("Quotation not found.", 404);

  quotation.status = status;
  quotation.tracking.push({ event: status, occuredAt: new Date(), ip: req.ip, device: req.headers["user-agent"] });
  await quotation.save();

  // If accepted, we might want to automatically move deal stage
  if (status === "accepted") {
    const customer = await Customer.findById(quotation.customerId);
    if (customer && customer.pipelineStage !== "won") {
      customer.pipelineStage = "won";
      customer.dealStage = "won";
      customer.status = "customer";
      customer.recordType = "customer";
      await customer.save();

      await createActivityEvent({
        actor: req.user,
        websiteId: customer.websiteId,
        entityType: "customer",
        entityId: customer._id,
        type: "stage_changed",
        summary: `Deal automatically won via quotation acceptance.`,
        metadata: { fromStage: "proposal", toStage: "won" }
      });
    }
  }

  res.json(quotation);
});

/**
 * Send a draft quotation (change status -> sent, push tracking, generate PDF placeholder)
 */
export const sendQuotation = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quotation = await Quotation.findById(id);
  if (!quotation) throw new AppError("Quotation not found.", 404);

  // Only owner or manager can send
  if (String(quotation.ownerId) !== String(req.user._id) && !["admin", "client", "manager"].includes(req.user.role)) {
    throw new AppError("Unauthorized to send this quotation", 403);
  }

  quotation.status = "sent";
  quotation.tracking.push({ event: "sent", occuredAt: new Date(), ip: req.ip, device: req.headers["user-agent"] });
  // placeholder pdf url - in future generate actual PDF
  quotation.pdfUrl = quotation.pdfUrl || `/uploads/quotations/${quotation.quotationId}.pdf`;
  await quotation.save();

  // Generate PDF file for the quotation (best-effort)
  try {
    const pdfResult = await generateQuotationPDF(quotation);
    if (pdfResult && pdfResult.path) {
      quotation.pdfUrl = pdfResult.path;
      await quotation.save();
    }
  } catch (err) {
    console.error("Failed to generate quotation PDF:", err);
  }

  await createAndEmitCrmNotification({
    recipient: quotation.ownerId,
    type: "crm_quote_sent",
    title: "Quotation Sent",
    message: `Quotation ${quotation.quotationId} has been sent to the customer.`,
    link: `/sales?leadId=${quotation.customerId}`
  });

  await createActivityEvent({
    actor: req.user,
    websiteId: quotation.websiteId,
    entityType: "quotation",
    entityId: quotation._id,
    type: "quote_sent",
    summary: `Quotation ${quotation.quotationId} sent to customer`,
    metadata: { quotationId: quotation.quotationId }
  });

  res.json(quotation);
});

/**
 * Approve a pending quotation (Manager only).
 */
export const approveQuotation = asyncHandler(async (req, res) => {
  requireRole("admin", "client", "manager");
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw new AppError("Quotation not found.", 404);

  quotation.status = "sent";
  quotation.tracking.push({ event: "sent", occuredAt: new Date(), ip: req.ip });
  await quotation.save();

  await createAndEmitCrmNotification({
    recipient: quotation.ownerId,
    type: "crm_quote_approved",
    title: "Quotation Approved",
    message: `Your quotation ${quotation.quotationId} has been authorized and sent to the customer.`,
    link: `/sales?leadId=${quotation.customerId}`
  });

  res.json(quotation);
});

/**
 * Deny a pending quotation (Manager only).
 */
export const denyQuotation = asyncHandler(async (req, res) => {
  requireRole("admin", "client", "manager");
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw new AppError("Quotation not found.", 404);

  quotation.status = "denied";
  quotation.tracking.push({ event: "denied", occuredAt: new Date(), ip: req.ip });
  await quotation.save();

  await createAndEmitCrmNotification({
    recipient: quotation.ownerId,
    type: "crm_quote_denied",
    title: "Quotation Denied",
    message: `Your quotation ${quotation.quotationId} was rejected by management. Review comments in notes.`,
    link: `/sales?leadId=${quotation.customerId}`
  });

  res.json(quotation);
});


export const promoteVisitor = asyncHandler(async (req, res) => {
  const { visitorId, sessionId, leadSource = "Live Chat" } = req.body;

  const visitor = await Visitor.findOne({ visitorId, websiteId: req.ownedWebsiteIds });
  if (!visitor) throw new AppError("Visitor record not found", 404);

  const customer = await getOrCreateCustomer({
    name: visitor.name || "Anonymous Chat Lead",
    email: visitor.email,
    websiteId: visitor.websiteId,
    visitorId: visitor.visitorId,
    leadSource,
    ownerId: req.user._id // Assign to the agent who clicked 'Promote'
  });

  if (!customer) throw new AppError("Failed to create customer record", 500);

  // Mark visitor with customer pointer
  visitor.customerId = customer._id;
  visitor.crn = customer.crn;
  await visitor.save();

  // If session provided, link it too
  if (sessionId) {
    await ChatSession.findOneAndUpdate(
      { sessionId, websiteId: visitor.websiteId },
      { customerId: customer._id, crn: customer.crn }
    );
  }

  // Audit
  await createActivityEvent({
    entityId: customer._id,
    entityType: "customer",
    action: "promoted",
    description: `Manually promoted from chat session ${sessionId || visitorId}`,
    performedBy: req.user._id,
    websiteId: visitor.websiteId
  });

  res.json(customer);
});

/**
 * Generate a code for a 'Won' lead and lock it from further stage changes.
 */
export const generateLeadCode = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_UPDATE);
  const id = req.params.id;
  const customer = await Customer.findById(id);
  if (!customer) throw new AppError("Lead not found", 404);

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  if (!ownedWebsiteIds.map(String).includes(String(customer.websiteId))) {
    throw new AppError("Unauthorized access to this lead", 403);
  }

  if (customer.pipelineStage !== "won") {
    throw new AppError("Codes can only be generated for leads in 'Won' stage", 400);
  }

  if (customer.isLocked) {
    return res.json(customer); // Idempotent
  }

  // Generate a premium-looking code
  const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  const code = `WON-${customer.crn}-${randomSuffix}`;

  customer.isLocked = true;
  customer.generatedCode = code;
  await customer.save();

  await emitCustomerActivity({
    actor: req.user,
    websiteId: customer.websiteId,
    customerId: customer._id,
    type: "status_changed",
    summary: `Lead locked and code ${code} generated`,
    metadata: { code }
  });

  await logAuditEvent({
    actor: req.user,
    action: "crm.lead_locked",
    entityType: "customer",
    entityId: customer._id,
    websiteId: customer.websiteId,
    metadata: { code },
    ipAddress: req.ip
  });

  res.json(customer);
});

/**
 * Global search for CRM leads (lightweight)
 */
export const searchCustomers = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_VIEW);
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const { q } = req.query;

  if (!q || q.length < 2) {
    return res.json([]);
  }

  const query = {
    websiteId: { $in: ownedWebsiteIds },
    archivedAt: null,
    $or: [
      { name: new RegExp(q, "i") },
      { email: new RegExp(q, "i") },
      { crn: new RegExp(q, "i") },
      { phone: new RegExp(q, "i") }
    ]
  };

  // Sales role restriction
  if (req.user.role === "sales") {
    query.ownerId = req.user._id;
  }

  const results = await Customer.find(query)
    .populate("websiteId", "websiteName")
    .select("name email phone crn pipelineStage websiteId")
    .limit(15)
    .sort({ lastInteraction: -1 });

  res.json(results);
});

/**
 * Bulk update customers
 */
export const bulkUpdateCustomers = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_UPDATE);
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("No customer IDs provided", 400);
  }

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  
  // Security check: ensure all requested IDs belong to the user's websites
  const customers = await Customer.find({ 
    _id: { $in: ids }, 
    websiteId: { $in: ownedWebsiteIds } 
  });

  if (customers.length === 0) {
    throw new AppError("No accessible leads found for the provided IDs", 404);
  }

  // Filter out locked leads
  const targetIds = customers
    .filter(c => !c.isLocked)
    .map(c => c._id);

  if (targetIds.length === 0) {
    throw new AppError("Selected leads are locked and cannot be updated", 403);
  }

  // Sanitize updates
  const allowedUpdates = {};
  const schema = ["status", "pipelineStage", "recordType", "leadStatus", "dealStage", "priority", "leadCategory", "interestLevel", "ownerId"];
  schema.forEach(key => {
    if (updates[key] !== undefined) allowedUpdates[key] = updates[key];
  });

  const updateResult = await Customer.updateMany(
    { _id: { $in: targetIds } },
    { $set: { ...allowedUpdates, lastInteraction: new Date() } }
  );

  await logAuditEvent({
    actor: req.user,
    action: "crm.bulk_update",
    entityType: "customer",
    entityId: "bulk",
    websiteId: customers[0]?.websiteId || null,
    metadata: { count: targetIds.length, updates: allowedUpdates, targetIds },
    ipAddress: req.ip
  });

  res.json({ success: true, count: updateResult.modifiedCount });
});

/**
 * Bulk delete customers
 */
export const bulkDeleteCustomers = asyncHandler(async (req, res) => {
  requirePermission(req.user, PERMISSIONS.CRM_DELETE);
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError("No customer IDs provided", 400);
  }

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  
  // Security check
  const customers = await Customer.find({ 
    _id: { $in: ids }, 
    websiteId: { $in: ownedWebsiteIds } 
  });

  if (customers.length === 0) {
    throw new AppError("No accessible leads found for the provided IDs", 404);
  }

  const targetIds = customers
    .filter(c => !c.isLocked)
    .map(c => c._id);

  if (targetIds.length === 0) {
    throw new AppError("Selected leads are locked and cannot be deleted", 403);
  }

  const deleteResult = await Customer.deleteMany({ _id: { $in: targetIds } });

  await logAuditEvent({
    actor: req.user,
    action: "crm.bulk_delete",
    entityType: "customer",
    entityId: "bulk",
    websiteId: customers[0]?.websiteId || null,
    metadata: { count: targetIds.length, targetIds },
    ipAddress: req.ip
  });

  res.json({ success: true, count: deleteResult.deletedCount });
});
