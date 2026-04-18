import { z } from "zod";
import AppError from "./AppError.js";
import {
  CRM_DEAL_STAGES,
  CRM_LEAD_STATUSES,
  CRM_LOST_REASONS,
  CRM_PIPELINE_STAGES,
  CRM_RECORD_TYPES,
  CRM_STATUSES,
  FOLLOW_UP_TASK_STATUSES,
  FOLLOW_UP_TASK_TYPES,
  TICKET_CRM_STAGES,
  TICKET_PRIORITIES,
  TICKET_STATUSES
} from "../constants/domain.js";

/** Run a Zod schema against req.body; throws AppError on failure */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.issues?.[0]?.message || "Invalid input";
      return next(new AppError(msg, 400));
    }
    req.body = result.data; // replace with parsed/sanitized data
    next();
  };
}

// ── Auth ────────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Please provide a valid email address"),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().optional(),
});

// ── Tickets ──────────────────────────────────────────────────────────────────
export const createTicketFromChatSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
  subject: z.string().min(3, "Subject must be at least 3 characters").max(200).optional(),
  priority: z.enum(TICKET_PRIORITIES).default("medium"),
  crmStage: z.enum(TICKET_CRM_STAGES).default("none"),
  category: z.string().max(100).optional(),
  subcategory: z.string().max(100).optional(),
});

export const updateTicketSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  crmStage: z.enum(TICKET_CRM_STAGES).optional(),
  category: z.string().max(100).optional(),
  subcategory: z.string().max(100).optional(),
  stage: z.string().optional(),
  note: z.string().max(2000).optional(),
  noteIsPublic: z.boolean().optional(),
  assignedAgent: z.string().nullable().optional(),
  assignmentReason: z.string().max(200).optional(),
  escalationLevel: z.number().int().min(0).max(10).optional(),
  watchers: z.array(z.string()).optional(),
  archiveReason: z.string().max(200).optional(),
}).refine(data => Object.keys(data).length > 0, { message: "At least one field is required" });

export const bulkUpdateTicketsSchema = z.object({
  ticketIds: z.array(z.string()).min(1, "At least one ticket ID is required"),
  updates: z.object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    crmStage: z.enum(TICKET_CRM_STAGES).optional(),
    assignedAgent: z.string().nullable().optional(),
    assignmentReason: z.string().max(200).optional(),
    escalationLevel: z.number().int().min(0).max(10).optional(),
    category: z.string().max(100).optional(),
    subcategory: z.string().max(100).optional(),
  }).refine(d => Object.keys(d).length > 0, { message: "At least one update field is required" }),
});

export const updateCustomerSchema = z.object({
  status: z.enum(CRM_STATUSES).optional(),
  pipelineStage: z.enum(CRM_PIPELINE_STAGES).optional(),
  recordType: z.enum(CRM_RECORD_TYPES).optional(),
  leadStatus: z.enum(CRM_LEAD_STATUSES).optional(),
  dealStage: z.enum(CRM_DEAL_STAGES).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).optional(),
  companyName: z.string().max(120).optional(),
  leadSource: z.string().max(120).optional(),
  leadValue: z.number().min(0).optional(),
  budget: z.number().min(0).optional(),
  requirement: z.string().max(500).optional(),
  timeline: z.string().max(120).optional(),
  interestLevel: z.enum(["cold", "warm", "hot"]).optional(),
  leadCategory: z.enum(["cold", "warm", "hot"]).optional(),
  probability: z.number().min(0).max(100).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  // Accept either the canonical enum or freeform text from the UI (e.g. "Lost to Competitor")
  lostReason: z.union([z.enum(CRM_LOST_REASONS), z.string().max(120)]).optional().or(z.literal("")),
  expectedCloseDate: z.union([z.string().max(40), z.null()]).optional(),
  decisionMaker: z.string().max(120).optional(),
  ownerId: z.string().nullable().optional(),
  assignmentReason: z.string().max(200).optional(),
  nextFollowUpAt: z.union([z.string().max(40), z.null()]).optional(),
  lastFollowUpAt: z.union([z.string().max(40), z.null()]).optional(),
  archiveReason: z.string().max(200).optional(),
}).refine(data => Object.keys(data).length > 0, { message: "At least one field is required" })
.superRefine((data, ctx) => {
  const isLost = data.pipelineStage === "lost" || data.status === "lost" || data.dealStage === "lost";
  if (isLost && !data.lostReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Lost reason is mandatory when deal is lost",
      path: ["lostReason"],
    });
  }
});

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  companyName: z.string().trim().max(120).optional().or(z.literal("")),
  recordType: z.enum(CRM_RECORD_TYPES).optional().default("lead"),
  leadStatus: z.enum(CRM_LEAD_STATUSES).optional().default("new"),
  dealStage: z.enum(CRM_DEAL_STAGES).nullable().optional(),
  leadSource: z.string().trim().min(1, "Source is required").max(120),
  leadValue: z.number().min(0).optional().default(0),
  budget: z.number().min(0, "Budget is required"),
  requirement: z.string().trim().min(1, "Requirement is required").max(500),
  timeline: z.string().trim().min(1, "Timeline is required").max(120),
  interestLevel: z.enum(["cold", "warm", "hot"]).optional().default("warm"),
  leadCategory: z.enum(["cold", "warm", "hot"]).optional(),
  probability: z.number().min(0).max(100).optional(),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  expectedCloseDate: z.string().max(40).optional().or(z.literal("")),
  decisionMaker: z.string().trim().max(120).optional().or(z.literal("")),
  websiteId: z.string().min(1, "Website is required"),
  status: z.enum(CRM_STATUSES).default("new"),
  pipelineStage: z.enum(CRM_PIPELINE_STAGES).default("new"),
  ownerId: z.string().optional().or(z.literal("")).or(z.null()),
  tags: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  notes: z.string().trim().max(2000).optional(),
  sessionId: z.string().optional().or(z.literal(""))
});

export const sendCustomerEmailSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(10).max(10000),
  ticketId: z.string().optional(),
  templateKey: z.string().max(80).optional()
});

export const createFollowUpTaskSchema = z.object({
  type: z.enum(FOLLOW_UP_TASK_TYPES).default("follow_up"),
  title: z.string().trim().min(3).max(160),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  dueAt: z.string().min(1, "Due date is required"),
  ownerId: z.string().nullable().optional().or(z.literal(""))
});

export const updateFollowUpTaskSchema = z.object({
  type: z.enum(FOLLOW_UP_TASK_TYPES).optional(),
  title: z.string().trim().min(3).max(160).optional(),
  notes: z.string().trim().max(2000).optional(),
  dueAt: z.string().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.enum(FOLLOW_UP_TASK_STATUSES).optional()
}).refine((data) => Object.keys(data).length > 0, { message: "At least one field is required" });

export const mergeCustomersSchema = z.object({
  primaryCustomerId: z.string().min(1),
  secondaryCustomerId: z.string().min(1)
}).refine((data) => data.primaryCustomerId !== data.secondaryCustomerId, {
  message: "Select two different CRM records"
});

export const submitVisitorTicketSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Valid email is required"),
  subject: z.string().min(3).max(200).optional(),
  message: z.string().min(1, "Message is required").max(5000),
  visitorId: z.string().optional(),
});

// ── Internal Notes ────────────────────────────────────────────────────────────
export const addInternalNoteSchema = z.object({
  content: z.string().min(1, "Note content is required").max(2000, "Note too long"),
});

// ── Chat Transfer ─────────────────────────────────────────────────────────────
export const transferChatSchema = z.object({
  toAgentId: z.string().min(1, "Target agent ID is required"),
  note: z.string().max(500).optional(),
});

// ── Website / Business Hours ──────────────────────────────────────────────────
const daySchema = z.object({
  isOpen: z.boolean().default(true),
  open: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM format").default("09:00"),
  close: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM format").default("17:00"),
});

export const businessHoursSchema = z.object({
  enabled: z.boolean().optional(),
  monday: daySchema.optional(),
  tuesday: daySchema.optional(),
  wednesday: daySchema.optional(),
  thursday: daySchema.optional(),
  friday: daySchema.optional(),
  saturday: daySchema.optional(),
  sunday: daySchema.optional(),
  timezone: z.string().default("Asia/Kolkata"),
});

export const webhookConfigSchema = z.object({
  url: z.string().url("Webhook URL must be valid"),
  secret: z.string().optional(),
  events: z.array(z.string()).min(1),
  isActive: z.boolean().optional()
});
