import mongoose from "mongoose";
import { NOTIFICATION_TYPES } from "../constants/domain.js";

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: NOTIFICATION_TYPES,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  link: {
    type: String
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  actorName: {
    type: String,
    trim: true,
    default: ""
  },
  entityType: {
    type: String,
    trim: true,
    default: ""
  },
  entityId: {
    type: String,
    trim: true,
    default: ""
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  isRead: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

export const Notification = mongoose.model("Notification", notificationSchema);
