import { logger } from "../utils/logger.js";
import Stripe from "stripe";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { buildSubscription } from "../utils/planUtils.js";
import asyncHandler from "../utils/asyncHandler.js";
import { logAuditEvent } from "../services/auditService.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";
import { getOwnedWebsiteIds } from "../utils/roleUtils.js";

const getStripe = () => {
  if (!env.stripeSecretKey || env.stripeSecretKey === "") {
    // For webhooks, we don't necessarily want to throw and crash, but we can't verify signatures without it.
    // However, constructEvent MUST have a key.
    return null;
  }
  return new Stripe(env.stripeSecretKey);
};

export const handleWebhook = asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    console.error("Stripe Webhook received but STRIPE_SECRET_KEY is missing. Cannot verify signature.");
    return res.status(500).send("Misconfigured Server: Check Stripe Secret Key");
  }
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // Use raw body for verification
      sig,
      env.stripeWebhookSecret
    );
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const { userId, plan } = session.metadata;
      if (userId && plan) {
        await User.findByIdAndUpdate(userId, {
          stripeSubscriptionId: session.subscription,
          subscription: buildSubscription(plan, { status: "active" })
        });
        await logAuditEvent({
          actor: { _id: userId },
          action: "billing.subscription_started",
          entityType: "user",
          entityId: userId,
          metadata: { plan, stripeSubscriptionId: session.subscription }
        });
      }
      break;
    }

    case "invoice.payment_succeeded": {
      const subscriptionId = session.subscription;
      if (subscriptionId) {
        await User.findOneAndUpdate(
          { stripeSubscriptionId: subscriptionId },
          { "subscription.status": "active" }
        );
      }
      break;
    }

    case "payment_intent.succeeded": {
      // Payment for a quotation succeeded
      try {
        const pi = event.data.object;
        const metadata = pi.metadata || {};
        const quotationId = metadata.quotationId || metadata.quotation_id;
        if (quotationId) {
          const quotation = await Quotation.findOne({ quotationId });
          if (quotation && quotation.status !== "accepted") {
            quotation.status = "accepted";
            quotation.tracking.push({ event: "accepted", occuredAt: new Date(), ip: req.ip });
            await quotation.save();

            // Move customer to won
            const customer = await Customer.findById(quotation.customerId);
            if (customer && customer.pipelineStage !== "won") {
              const prev = customer.pipelineStage;
              customer.pipelineStage = "won";
              customer.dealStage = "won";
              customer.status = "customer";
              customer.recordType = "customer";
              await customer.save();

              await createActivityEvent({
                actor: null,
                websiteId: customer.websiteId,
                entityType: "customer",
                entityId: customer._id,
                type: "stage_changed",
                summary: "Deal won via payment",
                metadata: { fromStage: prev, toStage: "won", quotationId: quotation.quotationId }
              });

              await createAndEmitCrmNotification({
                recipient: customer.ownerId,
                type: "crm_deal_won",
                title: "Deal confirmed",
                message: `${customer.name} marked won via payment`,
                link: `/crm/${customer._id}`
              });

              // Update analytics revenue (best-effort)
              try {
                await addWonRevenue(customer.websiteId, quotation.total || 0);
              } catch (err) {
                console.error("analytics update after payment failed", err);
              }
            }
          }
        }
      } catch (err) {
        console.error("Error handling payment_intent.succeeded webhook:", err);
      }
      break;
    }

    case "invoice.payment_failed": {
      const subscriptionId = session.subscription;
      if (subscriptionId) {
        const user = await User.findOneAndUpdate(
          { stripeSubscriptionId: subscriptionId },
          { "subscription.status": "expired" }
        );
        if (user) {
          await logAuditEvent({
            actor: user,
            action: "billing.payment_failed",
            entityType: "user",
            entityId: user._id,
            metadata: { stripeSubscriptionId: subscriptionId }
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscriptionId = session.id;
      const user = await User.findOneAndUpdate(
        { stripeSubscriptionId: subscriptionId },
        { "subscription.status": "expired" }
      );
      if (user) {
        await logAuditEvent({
          actor: user,
          action: "billing.subscription_canceled",
          entityType: "user",
          entityId: user._id,
          metadata: { stripeSubscriptionId: subscriptionId }
        });
      }
      break;
    }

    default:
      logger.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

export const listWebhookDeliveries = asyncHandler(async (req, res) => {
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const filter = req.user.role === "admin" ? {} : { websiteId: { $in: ownedWebsiteIds } };
  const deliveries = await WebhookDelivery.find(filter)
    .populate("websiteId", "websiteName domain")
    .sort({ attemptedAt: -1 })
    .limit(100);
  res.json(deliveries);
});
