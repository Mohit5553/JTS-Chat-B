import express from "express";
import { getTickets, createTicketFromChat, updateTicket, submitVisitorTicket, getTicketByPublicId, getVisitorHistory } from "../controllers/ticketController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Public endpoints (no auth needed)
router.post("/submit", submitVisitorTicket);
router.get("/public/:ticketId", getTicketByPublicId);

// Secured routes
router.use(requireAuth);
router.get("/visitor-history/:sessionId", requireRole("admin", "client", "agent"), getVisitorHistory);
router.get("/", requireRole("admin", "client", "agent"), getTickets);
router.post("/convert", requireRole("admin", "client", "agent"), createTicketFromChat);
router.patch("/:id", requireRole("admin", "client", "agent"), updateTicket);

export default router;
