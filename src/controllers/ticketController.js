import { Ticket } from "../models/Ticket.js";
import { ChatSession } from "../models/ChatSession.js";
import { Website } from "../models/Website.js";
import crypto from "crypto";

export const getTickets = async (req, res) => {
  try {
    const { websiteId, status, priority } = req.query;
    const filter = {};

    if (websiteId) filter.websiteId = websiteId;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    if (req.user.role === "client") {
      const websites = await Website.find({ managerId: req.user._id });
      filter.websiteId = { $in: websites.map(w => w._id) };
    } else if (req.user.role === "agent") {
      filter.assignedAgent = req.user._id;
    }

    const tickets = await Ticket.find(filter)
      .populate("visitorId", "name email")
      .populate("assignedAgent", "name email")
      .populate("websiteId", "websiteName domain")
      .sort({ createdAt: -1 });

    res.json(tickets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getTicketByPublicId = async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.ticketId })
      .populate("websiteId", "websiteName domain primaryColor")
      .populate("assignedAgent", "name");

    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    res.json({
      ticketId: ticket.ticketId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      channel: ticket.channel,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      website: ticket.websiteId ? {
        name: ticket.websiteId.websiteName,
        domain: ticket.websiteId.domain,
        primaryColor: ticket.websiteId.primaryColor
      } : null,
      agent: ticket.assignedAgent ? { name: ticket.assignedAgent.name } : null,
      notes: (ticket.notes || []).filter(n => n.isPublic).map(n => ({
        content: n.content,
        createdAt: n.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createTicketFromChat = async (req, res) => {
  try {
    const { sessionId, subject, priority } = req.body;
    const session = await ChatSession.findById(sessionId).populate("visitorId");

    if (!session) return res.status(404).json({ message: "Session not found" });

    const ticketCount = await Ticket.countDocuments();
    const ticketId = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;
    const shareToken = crypto.randomBytes(12).toString("hex");

    const ticket = new Ticket({
      ticketId,
      websiteId: session.websiteId,
      visitorId: session.visitorId._id,
      assignedAgent: session.assignedAgent || req.user._id,
      subject: subject || "Support Request from Live Chat",
      priority: priority || "medium",
      status: "open",
      lastMessagePreview: session.lastMessagePreview,
      shareToken
    });

    await ticket.save();

    res.status(201).json({ ...ticket.toObject(), shareToken });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, priority, note, noteIsPublic, assignedAgent } = req.body;

    const ticket = await Ticket.findById(id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    if (status) ticket.status = status;
    if (priority) ticket.priority = priority;
    if (assignedAgent !== undefined) ticket.assignedAgent = assignedAgent || null;

    if (note) {
      if (!ticket.notes) ticket.notes = [];
      ticket.notes.push({
        content: note,
        addedBy: req.user._id,
        isPublic: noteIsPublic !== false,
        createdAt: new Date()
      });
    }

    await ticket.save();
    const updated = await Ticket.findById(id)
      .populate("visitorId", "name email")
      .populate("assignedAgent", "name email")
      .populate("websiteId", "websiteName domain");

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const submitVisitorTicket = async (req, res) => {
  try {
    const { apiKey, name, email, subject, message, visitorId } = req.body;
    const website = await Website.findOne({ apiKey });
    if (!website) return res.status(400).json({ message: "Invalid API Key" });

    const ticketCount = await Ticket.countDocuments();
    const ticketId = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;
    const shareToken = crypto.randomBytes(12).toString("hex");

    const newTicket = new Ticket({
      ticketId,
      websiteId: website._id,
      visitorId: visitorId || null,
      subject: subject || "Inquiry from Offline Widget",
      lastMessagePreview: message,
      status: "open",
      priority: "medium",
      channel: "web",
      shareToken
    });

    await newTicket.save();
    res.status(201).json({
      message: "Ticket submitted successfully",
      ticketId,
      shareToken,
      statusUrl: `/ticket-status/${ticketId}`
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getVisitorHistory = async (req, res) => {
  try {
    const { ChatSession } = await import("../models/ChatSession.js");

    const session = await ChatSession.findOne({ sessionId: req.params.sessionId }).populate("visitorId");
    if (!session) return res.status(404).json({ message: "Session not found" });

    const visitorId = session.visitorId?._id;
    if (!visitorId) return res.json({ tickets: [], pastSessions: 0, visitor: null, hasOpenTickets: false });

    const [tickets, pastSessions] = await Promise.all([
      Ticket.find({ visitorId })
        .populate("assignedAgent", "name email")
        .populate("websiteId", "websiteName domain")
        .sort({ createdAt: -1 })
        .limit(10),
      ChatSession.countDocuments({ visitorId, status: "closed" })
    ]);

    res.json({
      visitor: {
        _id: session.visitorId._id,
        name: session.visitorId.name,
        email: session.visitorId.email,
        visitorId: session.visitorId.visitorId
      },
      tickets,
      pastSessions,
      hasOpenTickets: tickets.some(t => t.status === "open" || t.status === "pending")
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
