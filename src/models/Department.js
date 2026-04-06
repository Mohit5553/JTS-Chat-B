import mongoose from "mongoose";

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, lowercase: true },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

departmentSchema.index({ name: 1, websiteId: 1 }, { unique: true });

export const Department = mongoose.model("Department", departmentSchema);
