import mongoose from "mongoose";
import { CRM_STATUSES, CRM_PIPELINE_STAGES } from "../constants/domain.js";

const customerAssignmentHistorySchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, trim: true, default: "" },
  assignedAt: { type: Date, default: Date.now }
}, { _id: false });

const customerStageHistorySchema = new mongoose.Schema({
  fromStage: { type: String, enum: [...CRM_PIPELINE_STAGES], default: "new" },
  toStage: { type: String, enum: [...CRM_PIPELINE_STAGES], required: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  changedAt: { type: Date, default: Date.now },
  durationMs: { type: Number, default: 0 },
  reason: { type: String, trim: true, default: "" }
}, { _id: false });

const customerCommunicationSchema = new mongoose.Schema({
  type: { type: String, enum: ["email", "call", "whatsapp", "chat"], default: "email" },
  direction: { type: String, enum: ["inbound", "outbound"], default: "outbound" },
  to: { type: String, trim: true, lowercase: true, default: "" },
  subject: { type: String, trim: true, default: "" },
  body: { type: String, default: "" },
  status: { type: String, enum: ["sent", "logged", "failed"], default: "sent" },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", default: null },
  providerMessageId: { type: String, trim: true, default: "" },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  attachments: [{
    filename: { type: String, trim: true, default: "" },
    url: { type: String, trim: true, default: "" }
  }],
  sentAt: { type: Date, default: Date.now }
}, { _id: false });

const customerSchema = new mongoose.Schema(
  {
    crn: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, index: true },
    phone: { type: String, index: true },
    companyName: { type: String, trim: true, default: "" },
    leadSource: { type: String, trim: true, default: "" },
    leadValue: { type: Number, default: 0 },
    budget: { type: Number, default: 0 },
    interestLevel: { type: String, enum: ["cold", "warm", "hot"], default: "warm" },
    probability: { type: Number, min: 0, max: 100, default: 10 },
    score: { type: Number, default: 0 },
    lostReason: { type: String, trim: true, default: "" },
    expectedCloseDate: { type: Date, default: null },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    ownerAssignedAt: { type: Date, default: null },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium"
    },
    status: {
      type: String,
      enum: [...CRM_STATUSES],
      default: "new"
    },
    pipelineStage: {
      type: String,
      enum: [...CRM_PIPELINE_STAGES],
      default: "new"
    },
    stageEnteredAt: { type: Date, default: Date.now },
    stageHistory: [customerStageHistorySchema],
    tags: [{ type: String }],
    internalNotes: [{
      type: {
        type: String,
        enum: ["note", "call", "meeting", "manual_email"],
        default: "note"
      },
      text: { type: String, required: true },
      authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      authorName: String,
      createdAt: { type: Date, default: Date.now }
    }],
    firstInteraction: { type: Date, default: Date.now },
    lastInteraction: { type: Date, default: Date.now },
    lastActivity: { type: Date, default: Date.now },
    lastFollowUpAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null },
    assignmentHistory: [customerAssignmentHistorySchema],
    communications: [customerCommunicationSchema],
    sourceDetails: {
      sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "ChatSession", default: null },
      pageUrl: { type: String, trim: true, default: "" },
      firstPage: { type: String, trim: true, default: "" },
      device: { type: String, trim: true, default: "" },
      location: { type: String, trim: true, default: "" }
    },
    metadata: { type: Map, of: String },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, default: "" },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

// Compound index for finding existing customers within a specific website context
customerSchema.index({ email: 1, websiteId: 1 });
customerSchema.index({ phone: 1, websiteId: 1 });
customerSchema.index({ companyName: 1, websiteId: 1 });

// Performance indexes for common CRM query patterns
customerSchema.index({ ownerId: 1, archivedAt: 1, pipelineStage: 1 }); // "my leads" + auto-assign
customerSchema.index({ pipelineStage: 1, updatedAt: 1, websiteId: 1 }); // "won this month" view
customerSchema.index({ nextFollowUpAt: 1, websiteId: 1 });              // "no follow-up" view

export const Customer = mongoose.model("Customer", customerSchema);
