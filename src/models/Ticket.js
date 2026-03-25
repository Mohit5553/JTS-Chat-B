import mongoose from "mongoose";

const noteSchema = new mongoose.Schema({
  content: { type: String, required: true },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  isPublic: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const ticketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, unique: true },
    shareToken: { type: String },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    visitorId: { type: mongoose.Schema.Types.ObjectId, ref: "Visitor" },
    assignedAgent: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    subject: { type: String, required: true },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    status: { type: String, enum: ["open", "pending", "resolved", "closed"], default: "open" },
    lastMessagePreview: { type: String },
    channel: { type: String, default: "web" },
    isRead: { type: Boolean, default: false },
    notes: [noteSchema]
  },
  { timestamps: true }
);

export const Ticket = mongoose.model("Ticket", ticketSchema);
