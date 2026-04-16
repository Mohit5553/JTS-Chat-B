import express from "express";
import {
  getTickets, createTicketFromChat, updateTicket,
  submitVisitorTicket, getTicketByPublicId,
  getVisitorHistory, getCustomerHistoryByCRN,
  bulkUpdateTickets, exportTickets, getTicketActivity,
  deleteTicket, bulkDeleteTickets
} from "../controllers/ticketController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { attachTenantSubscription, requirePlanFeature } from "../middleware/planAccess.js";
import {
  validate,
  bulkUpdateTicketsSchema,
  createTicketFromChatSchema,
  submitVisitorTicketSchema,
  updateTicketSchema
} from "../utils/validators.js";

const router = express.Router();

// Public endpoints (no auth needed)
router.post("/submit", validate(submitVisitorTicketSchema), submitVisitorTicket);
router.get("/public/:ticketId", getTicketByPublicId);

// Secured routes
router.use(requireAuth);
router.use(attachTenantSubscription);
router.use(requirePlanFeature("tickets"));
router.get("/customer-history/:crn", requireRole("admin", "client", "manager", "agent", "sales"), getCustomerHistoryByCRN);
router.get("/visitor-history/:sessionId", requireRole("admin", "client", "manager", "agent", "sales"), getVisitorHistory);
router.get("/export", requireRole("admin", "client", "manager"), exportTickets);
router.get("/", requireRole("admin", "client", "manager", "agent", "sales"), getTickets);
router.get("/:id/activity", requireRole("admin", "client", "manager", "agent", "sales"), getTicketActivity);
router.post("/convert", requireRole("admin", "client", "manager", "agent", "sales"), validate(createTicketFromChatSchema), createTicketFromChat);
router.post("/bulk-update", requireRole("admin", "client", "manager", "agent"), validate(bulkUpdateTicketsSchema), bulkUpdateTickets);
router.post("/bulk-delete", requireRole("admin", "client", "manager"), bulkDeleteTickets);
router.patch("/:id", requireRole("admin", "client", "manager", "agent", "sales"), validate(updateTicketSchema), updateTicket);
router.delete("/:id", requireRole("admin", "client", "manager"), deleteTicket);

export default router;
