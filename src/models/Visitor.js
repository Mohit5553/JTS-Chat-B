import mongoose from "mongoose";

const visitorSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, index: true },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    ipAddress: String,
    deviceInfo: String,
    browser: String,
    os: String,
    device: String,
    name: String,
    email: String,
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    crn: { type: String, index: true },
    country: { type: String, default: "Unknown" },
    city: String,
    timezone: String,
    firstVisitTime: { type: Date, default: Date.now },
    lastVisitTime: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

visitorSchema.index({ visitorId: 1, websiteId: 1 }, { unique: true });

export const Visitor = mongoose.model("Visitor", visitorSchema);
