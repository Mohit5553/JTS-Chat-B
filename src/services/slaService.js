import { ChatSession } from "../models/ChatSession.js";
import { Ticket } from "../models/Ticket.js";
import { Website } from "../models/Website.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { createNotification } from "./notificationService.js";
import { sendEmail } from "./emailService.js";
import { slaBreachTemplate } from "../utils/emailTemplates.js";
import { processCrmAutomation, processTicketAutomation } from "./automationService.js";

async function alertManager(manager, breachType, details, dashboardUrl) {
  await createNotification({
    recipient: manager._id,
    type: "sla_breach",
    title: `SLA breach: ${breachType}`,
    message: details[0],
    link: dashboardUrl
  });

  const { html, subject } = slaBreachTemplate({
    managerName: manager.name,
    breachType,
    details,
    dashboardUrl
  });

  await sendEmail({ to: manager.email, subject, html });
}

export async function processSlaBreaches() {
  const queueCutoff = new Date(Date.now() - env.slaQueueAlertMinutes * 60 * 1000);
  const ticketCutoff = new Date(Date.now() - env.slaTicketAlertHours * 60 * 60 * 1000);

  const queuedSessions = await ChatSession.find({
    status: "queued",
    createdAt: { $lte: queueCutoff },
    queueAlertSentAt: null
  }).populate("websiteId", "websiteName managerId");

  for (const session of queuedSessions) {
    if (!session.websiteId?.managerId) continue;
    const manager = await User.findById(session.websiteId.managerId).select("name email");
    if (!manager) continue;

    const dashboardUrl = `${env.clientUrl}/client?tab=chats&sessionId=${session.sessionId}`;
    await alertManager(
      manager,
      "Queued chat",
      [
        `Chat ${session.sessionId} for ${session.websiteId.websiteName} has been waiting more than ${env.slaQueueAlertMinutes} minutes.`,
        `Created at ${session.createdAt.toISOString()}.`
      ],
      dashboardUrl
    );

    session.queueAlertSentAt = new Date();
    await session.save();
  }

  const staleTickets = await Ticket.find({
    status: { $nin: ["resolved", "closed", "archived"] },
    createdAt: { $lte: ticketCutoff },
    resolutionAlertSentAt: null
  }).populate("websiteId", "websiteName managerId");

  for (const ticket of staleTickets) {
    if (!ticket.websiteId?.managerId) continue;
    const manager = await User.findById(ticket.websiteId.managerId).select("name email");
    if (!manager) continue;

    const dashboardUrl = `${env.clientUrl}/client?tab=tickets`;
    await alertManager(
      manager,
      "Unresolved ticket",
      [
        `Ticket ${ticket.ticketId} (${ticket.subject}) is still unresolved after ${env.slaTicketAlertHours} hours.`,
        `Current status: ${ticket.status}.`
      ],
      dashboardUrl
    );

    ticket.resolutionAlertSentAt = new Date();
    await ticket.save();
  }

  await processCrmAutomation();
  await processTicketAutomation();
}

export function startSlaMonitor() {
  const intervalMs = 60 * 1000;
  processSlaBreaches().catch((error) => {
    console.error("Initial SLA monitor run failed:", error.message);
  });
  return setInterval(() => {
    processSlaBreaches().catch((error) => {
      console.error("SLA monitor run failed:", error.message);
    });
  }, intervalMs);
}
