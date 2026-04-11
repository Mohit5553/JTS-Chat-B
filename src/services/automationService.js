import { Customer } from "../models/Customer.js";
import { FollowUpTask } from "../models/FollowUpTask.js";
import { Ticket } from "../models/Ticket.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import { createNotification } from "./notificationService.js";
import { createActivityEvent } from "./activityService.js";
import { env } from "../config/env.js";
import { CRM_PIPELINE_STAGES } from "../constants/domain.js";

// Normalize a pipelineStage value to a valid enum — maps legacy values and silently
// corrects any invalid/stale data that may have existed before schema migrations.
function normalizePipelineStage(stage) {
  if (!stage) return "new";
  if (CRM_PIPELINE_STAGES.includes(stage)) return stage;
  // Map known legacy values
  const legacyMap = {
    proposition: "proposal_sent",
    hold: "contacted",
    opportunity: "qualified",
    prospect: "new",
    lead: "new",
    customer: "won",
    inactive: "lost"
  };
  return legacyMap[stage] || "new";
}

const TICKET_PRIORITY_RULES = {
  urgent: ["refund", "payment failed", "chargeback", "outage", "down", "breach", "urgent", "asap", "angry", "cancel now"],
  high: ["bug", "error", "failed", "invoice", "pricing", "demo", "proposal", "negotiation", "vip", "complaint"],
  medium: ["support", "follow up", "follow-up", "callback", "meeting", "quote", "quotation"]
};

export function inferTicketPriority({ subject = "", category = "", subcategory = "", note = "", lastMessagePreview = "" }) {
  const text = [subject, category, subcategory, note, lastMessagePreview].join(" ").toLowerCase();
  if (TICKET_PRIORITY_RULES.urgent.some((term) => text.includes(term))) return "urgent";
  if (TICKET_PRIORITY_RULES.high.some((term) => text.includes(term))) return "high";
  if (TICKET_PRIORITY_RULES.medium.some((term) => text.includes(term))) return "medium";
  return "low";
}

export function buildTicketSlaFields(priority = "medium", createdAt = new Date()) {
  const created = new Date(createdAt);
  const firstResponseHours = {
    low: 4,
    medium: 2,
    high: 1,
    urgent: 0.25
  };
  const resolutionHours = {
    low: 48,
    medium: 24,
    high: 8,
    urgent: 2
  };

  return {
    firstResponseDueAt: new Date(created.getTime() + (firstResponseHours[priority] || 2) * 60 * 60 * 1000),
    resolutionDueAt: new Date(created.getTime() + (resolutionHours[priority] || 24) * 60 * 60 * 1000)
  };
}

export async function pickBalancedSalesOwner({ websiteId, managerId, excludeOwnerId = null }) {
  const salesAgents = await User.find({
    role: "sales",
    ...(managerId ? { managerId } : {})
  }).select("_id name email websiteIds");

  const eligibleAgents = salesAgents.filter((agent) => {
    if (excludeOwnerId && String(agent._id) === String(excludeOwnerId)) return false;
    const assigned = Array.isArray(agent.websiteIds) ? agent.websiteIds : [];
    if (assigned.length === 0) return true;
    return assigned.some((id) => String(id) === String(websiteId));
  });

  if (eligibleAgents.length === 0) return null;

  const counts = await Customer.aggregate([
    {
      $match: {
        ownerId: { $in: eligibleAgents.map((agent) => agent._id) },
        archivedAt: null,
        pipelineStage: { $nin: ["won", "lost"] }
      }
    },
    { $group: { _id: "$ownerId", count: { $sum: 1 } } }
  ]);

  const countMap = new Map(counts.map((row) => [String(row._id), row.count]));

  return eligibleAgents
    .map((agent) => ({ agent, count: countMap.get(String(agent._id)) || 0 }))
    .sort((a, b) => a.count - b.count)[0]?.agent || null;
}

export async function autoAssignLeadOwner(customer, { assignedBy = null, reason = "auto_assign_round_robin", notify = true } = {}) {
  if (!customer || customer.ownerId) return null;

  const website = await Website.findById(customer.websiteId).select("managerId");
  const owner = await pickBalancedSalesOwner({
    websiteId: customer.websiteId,
    managerId: website?.managerId || null
  });

  if (!owner) return null;

  customer.ownerId = owner._id;
  customer.ownerAssignedAt = new Date();
  if (!customer.assignmentHistory) customer.assignmentHistory = [];
  customer.assignmentHistory.unshift({
    ownerId: owner._id,
    assignedBy,
    reason,
    assignedAt: new Date()
  });
  await customer.save();

  if (notify) {
    await createNotification({
      recipient: owner._id,
      type: "crm_lead_assigned",
      title: "Lead auto-assigned",
      message: `${customer.name} has been assigned to you automatically.`,
      link: "/sales"
    });
  }

  await createActivityEvent({
    actor: null,
    websiteId: customer.websiteId,
    entityType: "customer",
    entityId: customer._id,
    type: "auto_assigned",
    summary: `Lead auto-assigned to ${owner.name}`,
    metadata: { ownerId: owner._id, ownerName: owner.name, reason }
  });

  return owner;
}

export async function processCrmAutomation() {
  const tenMinutesAgo = new Date(Date.now() - env.crmLeadReassignMinutes * 60 * 1000);
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000);

  const unassignedLeads = await Customer.find({
    archivedAt: null,
    ownerId: null,
    pipelineStage: { $nin: ["won", "lost"] }
  }).limit(25);

  for (const lead of unassignedLeads) {
    // Silently correct any invalid pipelineStage before saving to avoid validation errors
    const normalizedStage = normalizePipelineStage(lead.pipelineStage);
    if (lead.pipelineStage !== normalizedStage) {
      lead.pipelineStage = normalizedStage;
    }
    await autoAssignLeadOwner(lead, { reason: "new_lead_auto_assignment" });
  }

  const staleLeads = await Customer.find({
    archivedAt: null,
    ownerId: { $ne: null },
    pipelineStage: { $nin: ["won", "lost"] },
    ownerAssignedAt: { $lte: tenMinutesAgo }
  }).limit(25);

  for (const lead of staleLeads) {
    const latestActionAt = new Date(lead.lastFollowUpAt || lead.lastActivity || lead.lastInteraction || lead.updatedAt);
    const lastAutoReassignedAt = lead.metadata?.get?.("lastAutoReassignedAt") || "";
    if (latestActionAt > tenMinutesAgo) continue;
    if (lastAutoReassignedAt && new Date(lastAutoReassignedAt) > tenMinutesAgo) continue;

    const website = await Website.findById(lead.websiteId).select("managerId");
    const nextOwner = await pickBalancedSalesOwner({
      websiteId: lead.websiteId,
      managerId: website?.managerId || null,
      excludeOwnerId: lead.ownerId
    });

    if (!nextOwner) continue;

    const previousOwnerId = lead.ownerId;
    lead.ownerId = nextOwner._id;
    lead.ownerAssignedAt = new Date();
    // Silently correct any invalid pipelineStage before saving
    lead.pipelineStage = normalizePipelineStage(lead.pipelineStage);
    if (!lead.assignmentHistory) lead.assignmentHistory = [];
    lead.assignmentHistory.unshift({
      ownerId: nextOwner._id,
      assignedBy: null,
      reason: "no_response_auto_reassignment",
      assignedAt: new Date()
    });
    if (lead.metadata?.set) {
      lead.metadata.set("lastAutoReassignedAt", new Date().toISOString());
    }
    await lead.save();

    await createNotification({
      recipient: nextOwner._id,
      type: "crm_lead_assigned",
      title: "Lead reassigned due to inactivity",
      message: `${lead.name} was reassigned after no follow-up activity.`,
      link: "/sales"
    });

    await createActivityEvent({
      actor: null,
      websiteId: lead.websiteId,
      entityType: "customer",
      entityId: lead._id,
      type: "auto_assigned",
      summary: `Lead reassigned automatically after inactivity`,
      metadata: {
        fromOwnerId: previousOwnerId,
        toOwnerId: nextOwner._id,
        reason: "no_response_auto_reassignment"
      }
    });
  }

  const dueTasks = await FollowUpTask.find({
    status: { $in: ["open", "in_progress"] },
    dueAt: { $lte: new Date(), $gte: oneMinuteAgo },
    ownerId: { $ne: null }
  })
    .populate("customerId", "name")
    .limit(50);

  for (const task of dueTasks) {
    await createNotification({
      recipient: task.ownerId,
      type: "crm_follow_up_due",
      title: "Follow-up reminder",
      message: `${task.customerId?.name || "Lead"}: ${task.title}`,
      link: "/sales?tab=tasks"
    });
  }
}

export async function processTicketAutomation() {
  const staleTickets = await Ticket.find({
    status: { $nin: ["resolved", "closed", "archived"] },
    resolutionDueAt: { $lte: new Date() },
    slaBreachedAt: null
  })
    .populate("websiteId", "managerId")
    .limit(50);

  for (const ticket of staleTickets) {
    ticket.slaBreachedAt = new Date();
    ticket.lastEscalatedAt = new Date();
    ticket.escalationLevel = Number(ticket.escalationLevel || 0) + 1;
    if (ticket.status === "open") {
      ticket.status = "waiting";
    }
    await ticket.save();

    if (ticket.assignedAgent) {
      await createNotification({
        recipient: ticket.assignedAgent,
        type: "sla_breach",
        title: "Ticket SLA breached",
        message: `${ticket.ticketId} requires attention.`,
        link: "/client?tab=tickets"
      });
    }

    const managerId = ticket.websiteId?.managerId || null;
    if (managerId) {
      await createNotification({
        recipient: managerId,
        type: "sla_breach",
        title: "Ticket escalated",
        message: `${ticket.ticketId} exceeded SLA and was escalated.`,
        link: "/client?tab=tickets"
      });
    }

    await createActivityEvent({
      actor: null,
      websiteId: ticket.websiteId?._id || ticket.websiteId,
      entityType: "ticket",
      entityId: ticket._id,
      type: "sla_breached",
      summary: `Ticket ${ticket.ticketId} breached SLA`,
      metadata: { escalationLevel: ticket.escalationLevel }
    });
  }
}
