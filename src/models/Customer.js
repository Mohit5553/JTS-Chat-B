import mongoose from "mongoose";
import { CRM_STATUSES, CRM_PIPELINE_STAGES } from "../constants/domain.js";

const customerAssignmentHistorySchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, trim: true, default: "" },
  assignedAt: { type: Date, default: Date.now }
}, { _id: false });

const customerCommunicationSchema = new mongoose.Schema({
  type: { type: String, enum: ["email"], default: "email" },
  direction: { type: String, enum: ["outbound"], default: "outbound" },
  to: { type: String, required: true, trim: true, lowercase: true },
  subject: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  status: { type: String, enum: ["sent", "logged"], default: "sent" },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket", default: null },
  providerMessageId: { type: String, trim: true, default: "" },
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
    tags: [{ type: String }],
    internalNotes: [{
      text: { type: String, required: true },
      authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      authorName: String,
      createdAt: { type: Date, default: Date.now }
    }],
    firstInteraction: { type: Date, default: Date.now },
    lastInteraction: { type: Date, default: Date.now },
    lastFollowUpAt: { type: Date, default: null },
    nextFollowUpAt: { type: Date, default: null },
    assignmentHistory: [customerAssignmentHistorySchema],
    communications: [customerCommunicationSchema],
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
