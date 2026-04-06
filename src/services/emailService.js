import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  // If SMTP credentials are configured, use them; otherwise use Ethereal (dev preview)
  if (env.smtpHost && env.smtpUser && env.smtpPass) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
  } else {
    // Fallback: log-only mode (no real emails sent in dev without SMTP config)
    transporter = {
      sendMail: async (opts) => {
        console.log(`\n📧 [EMAIL LOG - Configure SMTP to send real emails]\nTo: ${opts.to}\nSubject: ${opts.subject}\n---\n${opts.text || "(HTML email)"}\n`);
        return { messageId: "dev-mode" };
      }
    };
  }
  return transporter;
}

/**
 * Send an email. Gracefully logs errors without crashing the server.
 */
export async function sendEmail({ to, subject, html, text, replyTo, attachments = [] }) {
  try {
    const t = getTransporter();
    const info = await t.sendMail({
      from: env.smtpFrom,
      to,
      subject,
      html,
      text: text || subject,
      replyTo: replyTo || undefined,
      attachments,
    });
    console.log(`✅ Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    console.error(`❌ Email failed to ${to}:`, err.message);
    // Never throw — email failure should not break API responses
  }
}
