import mongoose from "mongoose";

const quotationItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1 },
  price: { type: Number, required: true },
  total: { type: Number, required: true }
}, { _id: false });

const quotationTrackingSchema = new mongoose.Schema({
  event: { type: String, enum: ["sent", "viewed", "accepted", "rejected", "pending_approval", "approved", "denied"], required: true },
  occuredAt: { type: Date, default: Date.now },
  ip: String,
  device: String
}, { _id: false });

const quotationSchema = new mongoose.Schema(
  {
    quotationId: { type: String, required: true, unique: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    items: [quotationItemSchema],
    subtotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: { 
      type: String, 
      enum: ["draft", "sent", "viewed", "accepted", "rejected", "expired", "pending_approval", "denied"], 
      default: "draft",
      index: true 
    },
    notes: { type: String, trim: true },
    terms: { type: String, trim: true },
    validUntil: { type: Date, required: true },
    pdfUrl: { type: String, trim: true },
    tracking: [quotationTrackingSchema]
  },
  { timestamps: true }
);

export const Quotation = mongoose.model("Quotation", quotationSchema);
