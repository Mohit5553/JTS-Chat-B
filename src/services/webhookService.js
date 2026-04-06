import crypto from "crypto";
import { Website } from "../models/Website.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";

function signPayload(secret, rawPayload) {
  return crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");
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
      let responseStatus = null;
      let responseBody = "";
      let success = false;

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
          body: rawPayload
        });

        responseStatus = response.status;
        responseBody = (await response.text()).slice(0, 2000);
        success = response.ok;
      } catch (error) {
        responseBody = error.message;
      }

      await WebhookDelivery.create({
        websiteId,
        endpointUrl: hook.url,
        event,
        payload: JSON.parse(rawPayload),
        responseStatus,
        responseBody,
        success,
        attemptedAt: new Date()
      });
    })
  );
}
