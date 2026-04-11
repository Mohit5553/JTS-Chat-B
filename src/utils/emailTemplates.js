// ─── Shared Layout ──────────────────────────────────────────────────────────
function layout(content, previewText = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Support</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;">${previewText}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);padding:32px 40px;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">💬 Chat Support</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.75);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Professional Support Platform</p>
          </td>
        </tr>
        <!-- Body -->
        <tr><td style="padding:40px;">${content}</td></tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">This email was sent by your Chat Support platform. Please do not reply to this email.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(text, url, color = "#4f46e5") {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:${color};color:#ffffff;padding:14px 32px;border-radius:10px;font-weight:800;font-size:14px;text-decoration:none;letter-spacing:0.3px;">${text}</a>
  </div>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;" />`;
}

function badge(text, color = "#4f46e5") {
  return `<span style="display:inline-block;background:${color}15;color:${color};border:1px solid ${color}30;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;">${text}</span>`;
}

// ─── Templates ──────────────────────────────────────────────────────────────

/** Forgot Password / Password Reset */
export function passwordResetTemplate({ name, resetUrl, expiresIn = "1 hour" }) {
  const content = `
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">Reset Your Password</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Hi <strong>${name}</strong>, we received a request to reset the password for your account. Click the button below to create a new password.</p>
    ${button("Reset My Password", resetUrl)}
    <p style="text-align:center;color:#94a3b8;font-size:12px;margin:-12px 0 24px;">This link expires in <strong>${expiresIn}</strong>.</p>
    ${divider()}
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
  `;
  return { html: layout(content, "Reset your Chat Support password"), subject: "Reset Your Password — Chat Support" };
}

/** Ticket Created Confirmation (for visitor) */
export function ticketCreatedTemplate({ ticketId, subject, statusUrl, priority = "medium", websiteName = "Support" }) {
  const priorityColors = { low: "#22c55e", medium: "#3b82f6", high: "#f97316", urgent: "#ef4444" };
  const content = `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin-bottom:28px;">
      <p style="margin:0;color:#166534;font-size:13px;font-weight:700;">✅ Your support ticket has been created successfully!</p>
    </div>
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">Ticket Confirmed</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Our team at <strong>${websiteName}</strong> has received your request and will respond shortly.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Ticket ID</span></td><td style="text-align:right;"><strong style="color:#1e293b;font-size:14px;">${ticketId}</strong></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Subject</span></td><td style="text-align:right;"><span style="color:#475569;font-size:13px;">${subject}</span></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Priority</span></td><td style="text-align:right;">${badge(priority, priorityColors[priority] || "#3b82f6")}</td></tr>
    </table>
    ${button("Track Your Ticket", statusUrl, "#4f46e5")}
    <p style="text-align:center;color:#94a3b8;font-size:12px;">Bookmark this link to check your ticket status anytime.</p>
  `;
  return { html: layout(content, `Ticket ${ticketId} created — we'll be in touch!`), subject: `Ticket Confirmed: ${ticketId} — ${subject}` };
}

/** Ticket Updated (status change notification) */
export function ticketUpdatedTemplate({ ticketId, subject, status, statusUrl, agentName, note }) {
  const statusColors = { open: "#3b82f6", in_progress: "#f97316", waiting: "#a855f7", resolved: "#22c55e", closed: "#64748b", pending: "#a855f7", archived: "#94a3b8" };
  const content = `
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">Your Ticket Has Been Updated</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Your support ticket status has changed.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Ticket</span></td><td style="text-align:right;"><strong style="color:#1e293b;">${ticketId}</strong></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Subject</span></td><td style="text-align:right;"><span style="color:#475569;font-size:13px;">${subject}</span></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">New Status</span></td><td style="text-align:right;">${badge(status.replace("_", " "), statusColors[status] || "#4f46e5")}</td></tr>
      ${agentName ? `<tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Agent</span></td><td style="text-align:right;"><span style="color:#475569;font-size:13px;">${agentName}</span></td></tr>` : ""}
    </table>
    ${note ? `<div style="background:#fafafa;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;"><p style="margin:0;color:#64748b;font-size:13px;font-style:italic;">"${note}"</p></div>` : ""}
    ${button("View Ticket", statusUrl)}
  `;
  return { html: layout(content, `Ticket ${ticketId} status updated to ${status}`), subject: `Ticket Updated: ${ticketId} — Now ${status.replace("_", " ")}` };
}

/** New Chat Assigned (for agent backup notification) */
export function chatAssignedTemplate({ agentName, visitorName, sessionId, dashboardUrl }) {
  const content = `
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">New Chat Assigned</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Hi <strong>${agentName}</strong>, a new visitor has been assigned to you and is waiting for support.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Visitor</span></td><td style="text-align:right;"><strong style="color:#1e293b;">${visitorName || "Anonymous"}</strong></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Session ID</span></td><td style="text-align:right;"><span style="color:#475569;font-family:monospace;font-size:12px;">${sessionId}</span></td></tr>
    </table>
    ${button("Open Chat Dashboard", dashboardUrl, "#4f46e5")}
  `;
  return { html: layout(content, "You have a new chat session waiting"), subject: `New Chat Assigned — ${visitorName || "Anonymous"} is waiting` };
}

/** Chat Transfer Notification */
export function chatTransferredTemplate({ agentName, fromAgentName, visitorName, sessionId, dashboardUrl }) {
  const content = `
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">Chat Transferred to You</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Hi <strong>${agentName}</strong>, <strong>${fromAgentName}</strong> has transferred a chat session to you.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Visitor</span></td><td style="text-align:right;"><strong style="color:#1e293b;">${visitorName || "Anonymous"}</strong></td></tr>
      <tr><td style="padding:8px 0;"><span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Transferred by</span></td><td style="text-align:right;"><span style="color:#475569;">${fromAgentName}</span></td></tr>
    </table>
    ${button("Accept Transfer", dashboardUrl, "#7c3aed")}
  `;
  return { html: layout(content, `Chat transferred from ${fromAgentName}`), subject: `Chat Transferred: ${visitorName || "Visitor"} — from ${fromAgentName}` };
}

/** SLA Breach Alert (for manager) */
export function slaBreachTemplate({ managerName, breachType, details, dashboardUrl }) {
  const content = `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:20px;margin-bottom:28px;">
      <p style="margin:0;color:#991b1b;font-size:13px;font-weight:700;">🚨 SLA Breach Detected — Immediate Attention Required</p>
    </div>
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">SLA Alert: ${breachType}</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Hi <strong>${managerName}</strong>, an SLA threshold has been breached and requires your attention.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
      ${details.map(d => `<p style="margin:0 0 8px;color:#475569;font-size:13px;">• ${d}</p>`).join("")}
    </div>
    ${button("View Dashboard", dashboardUrl, "#ef4444")}
  `;
  return { html: layout(content, `SLA Breach: ${breachType}`), subject: `🚨 SLA Breach Alert: ${breachType} — Action Required` };
}

/** Sales Outreach Email */
export function salesOutreachTemplate({ customerName, salesName, body, websiteName = "Support Team" }) {
  const safeBody = String(body || "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;"))
    .join("<br />");

  const content = `
    <h2 style="margin:0 0 8px;color:#1e293b;font-size:20px;font-weight:800;">Message from ${websiteName}</h2>
    <p style="margin:0 0 24px;color:#64748b;font-size:14px;line-height:1.7;">Hi <strong>${customerName || "there"}</strong>,</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;color:#475569;font-size:14px;line-height:1.8;">
      ${safeBody}
    </div>
    <p style="margin:0;color:#64748b;font-size:14px;line-height:1.7;">Best regards,<br /><strong>${salesName}</strong><br />${websiteName}</p>
  `;

  return {
    html: layout(content, `New message from ${salesName}`),
    subject: `Message from ${websiteName}`
  };
}
