import Stripe from "stripe";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import asyncHandler from "../utils/asyncHandler.js";
import AppError from "../utils/AppError.js";
import { buildSubscription } from "../utils/planUtils.js";

const getStripe = () => {
  if (!env.stripeSecretKey || env.stripeSecretKey === "") {
    throw new AppError("Stripe API key is missing. Please set STRIPE_SECRET_KEY in your .env file.", 500);
  }
  return new Stripe(env.stripeSecretKey);
};

export const createCheckoutSession = asyncHandler(async (req, res, next) => {
  const { plan } = req.body;
  const priceId = env.stripePriceIds[plan];

  if (!priceId) {
    return next(new AppError("Invalid plan selected", 400));
  }

  // Ensure user is a client/admin who can actually manage a subscription
  if (req.user.role !== "client" && req.user.role !== "admin") {
    return next(new AppError("Only clients can initiate a subscription", 403));
  }

  let customerId = req.user.stripeCustomerId;
  if (!customerId) {
    const stripe = getStripe();
    const customer = await stripe.customers.create({
      email: req.user.email,
      name: req.user.name,
      metadata: { userId: req.user._id.toString() }
    });
    customerId = customer.id;
    req.user.stripeCustomerId = customerId;
    await req.user.save();
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${env.clientUrl}/client?tab=billing&success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.clientUrl}/client?tab=billing&canceled=true`,
    metadata: { userId: req.user._id.toString(), plan }
  });

  res.json({ status: "success", url: session.url });
});

export const createPortalSession = asyncHandler(async (req, res, next) => {
  if (!req.user.stripeCustomerId) {
    return next(new AppError("No active billing account found", 404));
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: req.user.stripeCustomerId,
    return_url: `${env.clientUrl}/client?tab=billing`
  });

  res.json({ status: "success", url: session.url });
});

export const adminGetAllSubscriptions = asyncHandler(async (req, res, next) => {
  if (req.user.role !== "admin") {
    return next(new AppError("Only admins can access all subscriptions", 403));
  }
  const users = await User.find({ role: "client" }).select("name email subscription stripeSubscriptionId");
  res.json(users);
});
export const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({
    status: "success",
    subscription: user.subscription,
    stripeCustomerId: user.stripeCustomerId,
    stripeSubscriptionId: user.stripeSubscriptionId
  });
});

export const executeMockCheckout = asyncHandler(async (req, res, next) => {
  const { plan } = req.body;
  const validPlans = ["basic", "standard", "pro"];

  if (!validPlans.includes(plan)) {
    return next(new AppError("Invalid plan selected", 400));
  }

  const user = await User.findById(req.user._id);
  if (!user) {
    return next(new AppError("User not found", 404));
  }

  // Update subscription using the utility
  user.subscription = buildSubscription(plan, { status: "active" });

  await user.save();

  res.json({
    status: "success",
    message: `Plan ${plan} activated successfully (Mock Payment)`,
    subscription: user.subscription
  });
});
