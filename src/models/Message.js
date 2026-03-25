import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "ChatSession", required: true },
    sender: { type: String, enum: ["visitor", "agent", "system"], required: true },
    message: { type: String, trim: true, default: "" },
    attachmentUrl: { type: String, default: null },
    attachmentType: { type: String, enum: ["image", "pdf", "file", null], default: null },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    readAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export const Message = mongoose.model("Message", messageSchema);
