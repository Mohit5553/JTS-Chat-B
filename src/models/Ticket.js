import mongoose from "mongoose";

const noteSchema = new mongoose.Schema({
  content: { type: String, required: true },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  isPublic: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const assignmentHistorySchema = new mongoose.Schema({
  assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, trim: true, default: "" },
  assignedAt: { type: Date, default: Date.now }
}, { _id: false });

const ticketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, unique: true },
    shareToken: { type: String },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    visitorId: { type: mongoose.Schema.Types.ObjectId, ref: "Visitor" },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    crn: { type: String, index: true },
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignmentReason: { type: String, trim: true, default: "" },
    escalationLevel: { type: Number, default: 0 },
    subject: { type: String, required: true },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    status: { type: String, enum: ["open", "in_progress", "resolved", "closed", "pending", "archived"], default: "open" },
    crmStage: { 
      type: String, 
      enum: ["none", "lead", "qualified", "opportunity", "proposal", "negotiation", "won", "lost"], 
      default: "none" 
    },
    category: { type: String, trim: true },
    subcategory: { type: String, trim: true },
    department: { type: String, trim: true, lowercase: true, default: "general" },
    lastMessagePreview: { type: String },
    channel: { type: String, enum: ["chat", "web", "email"], default: "chat" },
    isRead: { type: Boolean, default: false },
    firstResponseAt: { type: Date },
    resolvedAt: { type: Date },
    resolutionAlertSentAt: { type: Date, default: null },
    assignmentHistory: [assignmentHistorySchema],
    notes: [noteSchema],
    watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, default: "" },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

export const Ticket = mongoose.model("Ticket", ticketSchema);
