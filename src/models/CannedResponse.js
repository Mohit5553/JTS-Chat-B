import mongoose from "mongoose";

const cannedResponseSchema = new mongoose.Schema(
  {
    shortcut: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Each manager's shortcuts must be unique
cannedResponseSchema.index({ managerId: 1, shortcut: 1 }, { unique: true });

export const CannedResponse = mongoose.model("CannedResponse", cannedResponseSchema);
