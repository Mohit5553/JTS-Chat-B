import crypto from "crypto";
import { Website } from "../models/Website.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";

function signPayload(secret, rawPayload) {
  return crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function attemptWebhookDelivery(hook, rawPayload, event, maxRetries = 3) {
  let lastError = null;
  let lastResponseStatus = null;
  let lastResponseBody = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-chat-support-event": event
      };

      if (hook.secret) {
        headers["x-chat-support-signature"] = signPayload(hook.secret, rawPayload);
      }

      const response = await fetch(hook.url, {
        method: "POST",
        headers,
        body: rawPayload,
        // Add timeout to prevent hanging
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      lastResponseStatus = response.status;
      lastResponseBody = (await response.text()).slice(0, 2000);

      if (response.ok) {
        return {
          success: true,
          responseStatus: lastResponseStatus,
          responseBody: lastResponseBody,
          attempts: attempt + 1
        };
      }

      // For non-2xx responses, we'll retry unless it's a client error (4xx)
      if (response.status >= 400 && response.status < 500) {
        // Don't retry client errors (except 408, 429)
        if (response.status !== 408 && response.status !== 429) {
          return {
            success: false,
            responseStatus: lastResponseStatus,
            responseBody: lastResponseBody,
            attempts: attempt + 1
          };
        }
      }

      lastError = new Error(`HTTP ${response.status}: ${lastResponseBody}`);
    } catch (error) {
      lastError = error;
      lastResponseBody = error.message;
    }

    // If this wasn't the last attempt, wait before retrying
    if (attempt < maxRetries) {
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      await sleep(delay);
    }
  }

  return {
    success: false,
    responseStatus: lastResponseStatus,
    responseBody: lastResponseBody,
    attempts: maxRetries + 1,
    error: lastError
  };
}

export async function dispatchWebsiteWebhook(websiteId, event, payload) {
  if (!websiteId || !event) return;

  const website = await Website.findById(websiteId).select("webhooks");
  if (!website?.webhooks?.length) return;

  const rawPayload = JSON.stringify({
    event,
    occurredAt: new Date().toISOString(),
    data: payload
  });

  const matchingHooks = website.webhooks.filter(
    (hook) =>
      hook.isActive !== false &&
      hook.url &&
      (hook.events?.includes("*") || hook.events?.includes(event))
  );

  await Promise.all(
    matchingHooks.map(async (hook) => {
      const result = await attemptWebhookDelivery(hook, rawPayload, event);

      await WebhookDelivery.create({
        websiteId,
        endpointUrl: hook.url,
        event,
        payload: JSON.parse(rawPayload),
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        success: result.success,
        attempts: result.attempts,
        attemptedAt: new Date()
      });
    })
  );
}
