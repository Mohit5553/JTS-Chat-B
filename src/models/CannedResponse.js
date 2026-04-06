import mongoose from "mongoose";

const cannedResponseSchema = new mongoose.Schema(
  {
    shortcut: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    visibility: { type: String, enum: ["shared", "personal"], default: "shared" },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Shared shortcuts remain unique per owner/tenant record, while personal shortcuts
// are isolated because personal records use the agent's own user id as managerId.
cannedResponseSchema.index({ managerId: 1, shortcut: 1 }, { unique: true });

export const CannedResponse = mongoose.model("CannedResponse", cannedResponseSchema);
