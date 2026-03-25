import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "client", "agent", "manager"], required: true },
    isOnline: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastActiveAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
