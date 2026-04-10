export const ROLES = Object.freeze({
  ADMIN: "admin",
  CLIENT: "client",
  MANAGER: "manager",
  AGENT: "agent",
  SALES: "sales",
  USER: "user"
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

// Updated CRM statuses to match new Lead Status field
export const CRM_STATUSES = Object.freeze([
  "new", "contacted", "qualified", "proposal_sent", "won", "lost",
  // legacy values kept for backwards compatibility
  "prospect", "lead", "customer", "inactive"
]);

export const CRM_PIPELINE_STAGES = Object.freeze(["new", "qualified", "hold", "proposition", "won", "lost"]);
export const TICKET_STATUSES = Object.freeze(["open", "in_progress", "resolved", "closed", "pending", "archived"]);
export const TICKET_PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const TICKET_CRM_STAGES = Object.freeze(["none", "lead", "qualified", "opportunity", "proposal", "negotiation", "won", "lost"]);
export const CHAT_STATUSES = Object.freeze(["active", "closed", "queued", "archived"]);

/**
 * Status transitions allowed for Sales role.
 * Key = current status, Value = array of statuses they can move to.
 */
export const SALES_ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  new: ["new", "contacted"],
  contacted: ["contacted", "qualified"],
  qualified: ["qualified", "proposal_sent"],
  proposal_sent: ["proposal_sent"],
  // legacy statuses
  prospect: ["prospect", "lead"],
  lead: ["lead", "customer"],
  customer: ["customer"],
  inactive: ["inactive"],
  // Sales cannot move won/lost
  won: ["won"],
  lost: ["lost"]
});

export const NOTIFICATION_TYPES = Object.freeze([
  "new_chat",
  "new_ticket",
  "status_update",
  "system_alert",
  "sla_breach",
  "crm_lead_assigned",
  "crm_follow_up_due",
  "crm_duplicate_detected",
  "crm_task_completed",
  "chat_transferred",
  "activity_alert"
]);

export const ACTIVITY_ENTITY_TYPES = Object.freeze([
  "customer",
  "ticket",
  "chat_session",
  "website",
  "follow_up_task",
  "notification",
  "settings"
]);

export const ACTIVITY_VISIBILITY = Object.freeze(["internal", "public"]);

export const ACTIVITY_TYPES = Object.freeze([
  "created",
  "updated",
  "archived",
  "restored",
  "deleted",
  "assigned",
  "unassigned",
  "stage_changed",
  "status_changed",
  "note_added",
  "email_sent",
  "task_created",
  "task_updated",
  "task_completed",
  "task_deleted",
  "duplicate_detected",
  "merged",
  "transferred",
  "comment_added",
  "settings_updated",
  "auto_assigned",
  "page_view"
]);

export const FOLLOW_UP_TASK_TYPES = Object.freeze([
  "call",
  "email",
  "meeting",
  "demo",
  "quotation",
  "follow_up",
  "custom"
]);

export const FOLLOW_UP_TASK_STATUSES = Object.freeze([
  "open",
  "in_progress",
  "completed",
  "cancelled"
]);
