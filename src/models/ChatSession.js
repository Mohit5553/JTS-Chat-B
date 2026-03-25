import mongoose from "mongoose";

const chatSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    visitorId: { type: mongoose.Schema.Types.ObjectId, ref: "Visitor", required: true },
    status: { type: String, enum: ["active", "closed", "queued"], default: "active" },
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    firstResponseAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    satisfactionStatus: { type: String, enum: ["satisfied", "unsatisfied"], default: null },
    satisfactionSubmittedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: "" }
  },
  { timestamps: true }
);

export const ChatSession = mongoose.model("ChatSession", chatSessionSchema);
