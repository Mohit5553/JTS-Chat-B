import { FollowUpTask } from "../models/FollowUpTask.js";
import { Quotation } from "../models/Quotation.js";

const CacheStore = {
  data: new Map(),
  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }
    return item.val;
  },
  set(key, val, ttlSeconds = 300) {
    this.data.set(key, { val, expiry: Date.now() + (ttlSeconds * 1000) });
  }
};

/**
 * Calculates a dynamic win probability based on pipeline stage, heat score, and activity velocity.
 */
export function calculateWinProbability(customer) {
  if (!customer) return 0;
  if (customer.pipelineStage === "won") return 100;
  if (customer.pipelineStage === "lost") return 0;

  // Base stage probabilities
  const stageWeights = {
    new: 5,
    contacted: 15,
    qualified: 30,
    proposal: 60,
    negotiation: 85
  };

  let prob = stageWeights[customer.pipelineStage] || 5;

  // Adjust by heat score (normalized to +/- 10%)
  const heatAdjustment = (customer.heatScore - 50) / 5; 
  prob += heatAdjustment;

  // Adjust by activity velocity (last touch within 24 hours = +5%)
  const hoursSinceInteraction = (new Date() - new Date(customer.lastInteraction)) / (1000 * 60 * 60);
  if (hoursSinceInteraction < 24) prob += 5;
  if (hoursSinceInteraction > 168) prob -= 15; // Unattended for a week

  return Math.max(0, Math.min(99, Math.round(prob)));
}

/**
 * Generates the Next Best Action recommendation based on the current state of the lead/deal.
 */
async function computeNextBestAction(customer) {
  if (!customer || customer.pipelineStage === "won" || customer.pipelineStage === "lost") return null;

  const now = new Date();
  const interactionGapDays = (now - new Date(customer.lastInteraction)) / (1000 * 60 * 60 * 24);

  // NBA Logic
  if (customer.pipelineStage === "new") {
    return {
      action: "Initial Outreach",
      recommendation: "New lead requires immediate first-touch contact.",
      priority: "high",
      icon: "UserPlus"
    };
  }

  if (customer.pipelineStage === "contacted" && interactionGapDays > 2) {
    return {
      action: "Nurture Lead",
      recommendation: `No activity for ${Math.floor(interactionGapDays)} days. Send a follow-up email.`,
      priority: "medium",
      icon: "Mail"
    };
  }

  if (customer.pipelineStage === "qualified") {
    const quote = await Quotation.findOne({ customerId: customer._id });
    if (!quote) {
      return {
        action: "Send Proposal",
        recommendation: "Lead is qualified. Draft and send the formal proposal.",
        priority: "high",
        icon: "Send"
      };
    }
  }

  if (customer.pipelineStage === "proposal" && interactionGapDays > 3) {
    return {
      action: "Review Proposal",
      recommendation: "Proposal sent 3+ days ago. Call to check acceptance status.",
      priority: "high",
      icon: "Phone"
    };
  }

  if (customer.pipelineStage === "negotiation" && interactionGapDays > 5) {
    return {
      action: "Escalate Deal",
      recommendation: "Stalled negotiation. Suggested manager intervention for closing.",
      priority: "high",
      icon: "Shield"
    };
  }

  // Activity-based churn warning
  if (customer.status === "customer" && interactionGapDays > 30) {
     return {
       action: "Retention Check",
       recommendation: "Inhabited customer. Perform a 30-day health check-in.",
       priority: "medium",
       icon: "LifeBuoy"
     };
  }

  return {
    action: "Maintenance",
    recommendation: "Lead is active. Maintain regular follow-up schedule.",
    priority: "low",
    icon: "Clock"
  };
}

export async function getNextBestAction(customer) {
  if (!customer || !customer._id) return null;
  const ts = customer.lastInteraction ? new Date(customer.lastInteraction).getTime() : 0;
  const cacheKey = `nba_cust_${customer._id}_${customer.pipelineStage}_${ts}`;
  const cached = CacheStore.get(cacheKey);
  if (cached) return cached;
  
  const res = await computeNextBestAction(customer);
  CacheStore.set(cacheKey, res, 300); // 5 mins
  return res;
}

/**
 * Calculates churn risk for existing customers.
 */
export function calculateChurnRisk(customer, metrics = {}) {
  if (customer.status !== "customer") return 0;
  
  const interactionGapDays = (new Date() - new Date(customer.lastInteraction)) / (1000 * 60 * 60 * 24);
  let risk = 0;

  if (interactionGapDays > 30) risk += 40;
  if (interactionGapDays > 90) risk += 50;

  // Factor in support ticket volume if provided
  if (metrics.unresolvedTickets > 3) risk += 20;

  return Math.min(100, risk);
}

/**
 * Calculates a heat score (0-100) based on engagement depth and recent activity.
 */
/**
 * Calculates a Heat Score (0-100) specifically for support tickets.
 * Focuses on SLA pressure, priority, and engagement velocity.
 */
export function calculateTicketHeatScore(ticket) {
  let score = 20; // base

  // 1. Priority weighting
  const priorityWeights = { urgent: 50, high: 30, medium: 10, low: 0 };
  score += priorityWeights[ticket.priority] || 10;

  // 2. SLA Pressure
  if (ticket.status !== "resolved" && ticket.status !== "closed") {
    const dueAt = ticket.resolutionDueAt ? new Date(ticket.resolutionDueAt) : null;
    if (dueAt) {
      const hoursUntilBreach = (dueAt - new Date()) / (1000 * 60 * 60);
      if (hoursUntilBreach < 0) score += 30; // already breached
      else if (hoursUntilBreach < 2) score += 20;
      else if (hoursUntilBreach < 8) score += 10;
    }
  }

  // 3. Status Tension
  if (ticket.status === "waiting") score += 5; // stalled

  return Math.max(0, Math.min(100, score));
}

/**
 * AI-driven Next Best Action for support tickets.
 */
async function computeTicketNBA(ticket) {
  if (!ticket || ["resolved", "closed"].includes(ticket.status)) return null;

  const now = new Date();
  const ageDays = (now - new Date(ticket.createdAt)) / (1000 * 60 * 60 * 24);

  // NBA Logic for Support
  if (ticket.status === "open" && !ticket.assignedAgent) {
    return {
      action: "Assign Resource",
      recommendation: "Ticket is unassigned. Assign to an available agent immediately.",
      priority: "high",
      icon: "UserPlus"
    };
  }

  if (ticket.priority === "urgent" && ticket.status !== "resolved") {
    return {
      action: "Immediate Action",
      recommendation: "Urgent ticket requires proactive resolution attempt within 60 mins.",
      priority: "urgent",
      icon: "Zap"
    };
  }

  if (["sales", "billing", "presales"].includes(ticket.department)) {
     return {
       action: "Upsell Path",
       recommendation: "Sales-related inquiry detected. Treat as high-value lead opportunity.",
       priority: "medium",
       icon: "TrendingUp"
     };
  }

  if (ticket.status === "waiting" && ageDays > 3) {
      return {
          action: "Close Stale",
          recommendation: "Awaiting visitor for 3+ days. Suggest closing with auto-nurture.",
          priority: "low",
          icon: "Archive"
      };
  }

  return {
    action: "Normal Flow",
    recommendation: "Follow standard resolution protocol for this category.",
    priority: "low",
    icon: "Clock"
  };
}

export async function getTicketNBA(ticket) {
  if (!ticket || !ticket._id) return null;
  const cacheKey = `nba_tic_${ticket._id}_${ticket.status}_${ticket.assignedAgent ? "1" : "0"}`;
  const cached = CacheStore.get(cacheKey);
  if (cached) return cached;
  
  const res = await computeTicketNBA(ticket);
  CacheStore.set(cacheKey, res, 300); // 5 mins
  return res;
}

export function calculateHeatScore(customer, sessionMetrics = {}) {
  let score = 30; // Starting baseline

  // 1. Message Volume (Engagement Depth)
  const messageCount = sessionMetrics.messageCount || 0;
  score += Math.min(40, messageCount * 2);

  // 2. Frequency / Recency
  const hoursSinceInteraction = (new Date() - new Date(customer.lastInteraction)) / (1000 * 60 * 60);
  if (hoursSinceInteraction < 1) score += 20; // Active right now/very recently
  else if (hoursSinceInteraction < 24) score += 10;
  else if (hoursSinceInteraction > 168) score -= 30; // Ice cold after a week

  // 3. Stage Momentum
  if (["proposal", "negotiation"].includes(customer.pipelineStage)) score += 15;

  return Math.max(0, Math.min(100, score));
}
