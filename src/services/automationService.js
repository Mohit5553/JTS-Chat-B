import { Customer } from "../models/Customer.js";
import { FollowUpTask } from "../models/FollowUpTask.js";
import { Ticket } from "../models/Ticket.js";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import { createNotification } from "./notificationService.js";
import { createActivityEvent } from "./activityService.js";
import { env } from "../config/env.js";
import { CRM_PIPELINE_STAGES } from "../constants/domain.js";
import { sendEmail } from "./emailService.js";

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

export async function pickBalancedSalesOwner({ websiteId, managerId, leadIndustry = "", leadTerritory = "", excludeOwnerId = null }) {
  const salesAgents = await User.find({
    role: "sales",
    ...(managerId ? { managerId } : {})
  }).select("_id name email websiteIds specialties territories");

  const eligibleAgents = salesAgents.filter((agent) => {
    if (excludeOwnerId && String(agent._id) === String(excludeOwnerId)) return false;
    const assigned = Array.isArray(agent.websiteIds) ? agent.websiteIds : [];
    if (assigned.length === 0) return true;
    return assigned.some((id) => String(id) === String(websiteId));
  });

  if (eligibleAgents.length === 0) return null;

  // Tier 2: Advanced Routing Logic (Industry & Territory matching)
  let candidates = eligibleAgents;
  
  if (leadIndustry || leadTerritory) {
    const specialMatch = eligibleAgents.filter(a => 
      (leadIndustry && (a.specialties || []).map(s => s.toLowerCase()).includes(leadIndustry.toLowerCase())) ||
      (leadTerritory && (a.territories || []).map(t => t.toLowerCase()).includes(leadTerritory.toLowerCase()))
    );
    if (specialMatch.length > 0) {
      candidates = specialMatch;
    }
  }

  const counts = await Customer.aggregate([
    {
      $match: {
        ownerId: { $in: candidates.map((agent) => agent._id) },
        archivedAt: null,
        pipelineStage: { $nin: ["won", "lost"] }
      }
    },
    { $group: { _id: "$ownerId", count: { $sum: 1 } } }
  ]);

  const countMap = new Map(counts.map((row) => [String(row._id), row.count]));

  return candidates
    .map((agent) => ({ agent, count: countMap.get(String(agent._id)) || 0 }))
    .sort((a, b) => a.count - b.count)[0]?.agent || null;
}

export async function ensureFirstTouchTask(customer, ownerId) {
  if (!customer || !ownerId) return;

  const existing = await FollowUpTask.findOne({
    customerId: customer._id,
    title: /Contact Lead|First Touch/i,
    status: { $in: ["open", "in_progress"] }
  });

  if (existing) return;

  const dueAt = new Date();
  dueAt.setHours(dueAt.getHours() + 2); // Task due in 2 hours

  await FollowUpTask.create({
    websiteId: customer.websiteId,
    customerId: customer._id,
    ownerId,
    title: `First Touch: Contact ${customer.name}`,
    description: `Auto-generated task to ensure prompt first-touch for the newly assigned lead.`,
    priority: "high",
    dueAt,
    type: "call"
  });
}

export async function sendCrmLifecycleEmail(customer, type) {
  if (!customer?.email) return;

  const website = await Website.findById(customer.websiteId);
  const templates = {
    welcome: {
      subject: `Thank you for your interest in ${website?.websiteName || "our services"}`,
      html: `
        <h2>Hi ${customer.name},</h2>
        <p>Thanks for reaching out! We've received your inquiry regarding <b>${customer.requirement || "our products"}</b>.</p>
        <p>One of our team members will be in touch with you shortly to discuss your requirements in detail.</p>
        <br/>
        <p>Best Regards,<br/>Team ${website?.websiteName || "Support"}</p>
      `
    },
    follow_up: {
      subject: `Checking in: ${website?.websiteName || "Your inquiry"}`,
      html: `
        <h2>Hi ${customer.name},</h2>
        <p>I wanted to follow up on our previous communication regarding your interest in <b>${customer.requirement}</b>.</p>
        <p>Do you have any further questions we can help with?</p>
        <br/>
        <p>Best Regards,<br/>Team ${website?.websiteName || "Support"}</p>
      `
    }
  };

  const template = templates[type];
  if (!template) return;

  await sendEmail({
    to: customer.email,
    subject: template.subject,
    html: template.html
  });
}

export async function autoAssignLeadOwner(customer, { assignedBy = null, reason = "auto_assign_round_robin", notify = true } = {}) {
  if (!customer || customer.ownerId) return null;

  const website = await Website.findById(customer.websiteId).select("managerId");
  const owner = await pickBalancedSalesOwner({
    websiteId: customer.websiteId,
    managerId: website?.managerId || null,
    leadIndustry: customer.industry || "",
    leadTerritory: customer.territory || ""
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

  // Phase 3 & 4: Automation on assignment
  await ensureFirstTouchTask(customer, owner._id);
  await sendCrmLifecycleEmail(customer, "welcome");

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
      leadIndustry: lead.industry || "",
      leadTerritory: lead.territory || "",
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
    if (task.notified) continue;
    await createNotification({
      recipient: task.ownerId,
      type: "crm_follow_up_due",
      title: "Follow-up reminder",
      message: `${task.customerId?.name || "Lead"}: ${task.title}`,
      link: "/sales?tab=tasks"
    });
    task.notified = true;
    await task.save();
  }

  // Phase 4: Overdue Escalation
  const overdueTasks = await FollowUpTask.find({
    status: { $in: ["open", "in_progress"] },
    dueAt: { $lte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // 24 hours overdue
    ownerId: { $ne: null },
    escalated: { $ne: true }
  }).populate("ownerId", "managerId").populate("customerId", "name").limit(50);

  for (const task of overdueTasks) {
    const managerId = task.ownerId?.managerId;
    if (managerId) {
      await createNotification({
        recipient: managerId,
        type: "system_alert",
        title: "Overdue Task Escalation",
        message: `Task for ${task.customerId?.name || "Lead"} assigned to ${task.ownerId?.name || 'Agent'} is overdue.`,
        link: "/client?tab=crm"
      });
    }
    task.escalated = true;
    await task.save();

    // Flag sales user if multiple overdue
    const overdueCount = await FollowUpTask.countDocuments({
      status: { $in: ["open", "in_progress"] },
      dueAt: { $lte: new Date() },
      ownerId: task.ownerId._id
    });
    if (overdueCount >= 3 && managerId) {
       await createNotification({
         recipient: managerId,
         type: "system_alert",
         title: "Agent Flagged: Multiple Overdue Tasks",
         message: `${task.ownerId.name} has ${overdueCount} overdue tasks.`,
         link: "/client?tab=crm"
       });
    }
  }

  // Phase 4: Mandatory task rule - check if leads lack a task and flag them
  const noFollowUpLeads = await Customer.find({
    recordType: { $ne: "customer" },
    archivedAt: null,
    nextFollowUpAt: null,
    ownerId: { $ne: null },
    lastInteraction: { $lte: tenMinutesAgo }
  }).limit(20);

  for (const lead of noFollowUpLeads) {
     const tasksCount = await FollowUpTask.countDocuments({ customerId: lead._id, status: { $in: ["open", "in_progress"] } });
     if (tasksCount === 0) {
       // Flag "No Follow-up" by setting a flag or notifying manager
       const owner = await User.findById(lead.ownerId);
       if (owner && owner.managerId) {
         await createNotification({
           recipient: owner.managerId,
           type: "system_alert",
           title: "Lead without follow-up",
           message: `Lead ${lead.name} has no upcoming tasks.`,
           link: "/client?tab=crm"
         });
       }
       // We only want to flag once to prevent spam, we can touch a metadata field
       if (lead.metadata && lead.metadata.set) {
         lead.metadata.set("missingTaskFlagged", new Date().toISOString());
         await lead.save();
       }
     }
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
