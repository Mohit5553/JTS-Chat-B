export const ROLES = Object.freeze({
  ADMIN: "admin",
  CLIENT: "client",
  MANAGER: "manager",
  AGENT: "agent",
  SALES: "sales",
  USER: "user"
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

export const CRM_STATUSES = Object.freeze(["prospect", "lead", "customer", "inactive"]);
export const CRM_PIPELINE_STAGES = Object.freeze(["new", "qualified", "hold", "proposition", "won", "lost"]);
export const TICKET_STATUSES = Object.freeze(["open", "in_progress", "resolved", "closed", "pending", "archived"]);
export const TICKET_PRIORITIES = Object.freeze(["low", "medium", "high", "urgent"]);
export const TICKET_CRM_STAGES = Object.freeze(["none", "lead", "qualified", "opportunity", "proposal", "negotiation", "won", "lost"]);
export const CHAT_STATUSES = Object.freeze(["active", "closed", "queued", "archived"]);

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
  "settings_updated"
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
