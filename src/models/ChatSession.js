import mongoose from "mongoose";

const internalNoteSchema = new mongoose.Schema({
  content: { type: String, required: true, trim: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  agentName: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const transferHistorySchema = new mongoose.Schema({
  fromAgentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  toAgentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, trim: true, default: "" },
  note: { type: String, trim: true, default: "" },
  transferredAt: { type: Date, default: Date.now }
}, { _id: false });

const chatSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    visitorId: { type: mongoose.Schema.Types.ObjectId, ref: "Visitor", required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    crn: { type: String, index: true },
    status: { type: String, enum: ["active", "closed", "queued"], default: "active" },
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    transferredFrom: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    firstResponseAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    satisfactionStatus: { type: String, enum: ["satisfied", "unsatisfied"], default: null },
    satisfactionSubmittedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: "" },
    currentPage: { type: String, default: "" },
    internalNotes: [internalNoteSchema],
    queueAlertSentAt: { type: Date, default: null },
    firstPage: { type: String, default: "" },
    visitHistory: [{ type: String, trim: true }],
    transferHistory: [transferHistorySchema],
    missedReason: { type: String, trim: true, default: "" },
    unreadCount: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null, index: true },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archiveReason: { type: String, trim: true, default: "" },
    restoredAt: { type: Date, default: null },
    restoredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    botStatus: { type: String, enum: ["idle", "in_progress", "resolved", "escalated"], default: "idle" },
    resolvedByBot: { type: Boolean, default: false },
    botMetadata: {
      path: [{ type: String }],
      selections: { type: mongoose.Schema.Types.Mixed, default: {} }
    }
  },
  { timestamps: true }
);

export const ChatSession = mongoose.model("ChatSession", chatSessionSchema);

