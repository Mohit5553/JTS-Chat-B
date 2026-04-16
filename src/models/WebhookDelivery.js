import mongoose from "mongoose";

const webhookDeliverySchema = new mongoose.Schema(
  {
    websiteId: { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true, index: true },
    endpointUrl: { type: String, required: true },
    event: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    responseStatus: { type: Number, default: null },
    responseBody: { type: String, default: "" },
    success: { type: Boolean, default: false, index: true },
    attempts: { type: Number, default: 1 },
    attemptedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const WebhookDelivery = mongoose.model("WebhookDelivery", webhookDeliverySchema);
