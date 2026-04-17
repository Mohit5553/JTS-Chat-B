import mongoose from "mongoose";

const invoiceItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1 },
  price: { type: Number, required: true },
  total: { type: Number, required: true }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true, index: true },
  quotationId: { type: String, trim: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
  websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  items: [invoiceItemSchema],
  subtotal: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: { type: String, enum: ["pending", "paid", "void"], default: "pending", index: true },
  paymentIntentId: { type: String, trim: true },
  pdfUrl: { type: String, trim: true },
  notes: { type: String, trim: true },
  issuedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export const Invoice = mongoose.model("Invoice", invoiceSchema);
