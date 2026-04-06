import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    department: { type: String, required: true, trim: true, lowercase: true, default: "general" },
    name: { type: String, required: true, trim: true },
    subcategories: [{ type: String, trim: true }],
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
  },
  { timestamps: true }
);

// Each website can only have one category of a specific name
categorySchema.index({ name: 1, websiteId: 1 }, { unique: true });

export const Category = mongoose.model("Category", categorySchema);
