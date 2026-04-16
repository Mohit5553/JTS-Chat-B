import { logger } from "../utils/logger.js";
import { Customer } from "../models/Customer.js";
import { incrementCustomers } from "./analyticsService.js";
import { User } from "../models/User.js";

/**
 * Generates a unique CRN in the format CRN-YYYY-XXXX
 * @returns {Promise<string>} The generated CRN
 */
export const generateCRN = async () => {
  const year = new Date().getFullYear();
  const prefix = `CRN-${year}-`;

  // Find the last CRN for the current year
  const lastCustomer = await Customer.findOne({ crn: new RegExp(`^${prefix}`) })
    .sort({ crn: -1 })
    .select("crn");

  let nextNumber = 1;
  if (lastCustomer && lastCustomer.crn) {
    const lastNumberStr = lastCustomer.crn.split("-").pop();
    nextNumber = parseInt(lastNumberStr, 10) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, "0")}`;
};

/**
 * Locates an existing customer by email/phone/visitorId or creates a new one.
 * @param {Object} data - Customer data { name, email, phone, websiteId, visitorId }
 * @returns {Promise<Object>} The Customer document
 */
export const getOrCreateCustomer = async (data) => {
  const { name, email, phone, websiteId, visitorId } = data;

  // Resolve the email — use real email, or a placeholder for anonymous visitors
  const resolvedEmail = email || (visitorId ? `anon-${visitorId}@visitor.local` : null);

  // We need at least some unique identifier
  if (!resolvedEmail && !phone) return null;

  const query = { websiteId };
  if (resolvedEmail && phone) {
    query.$or = [{ email: resolvedEmail }, { phone }];
  } else if (resolvedEmail) {
    query.email = resolvedEmail;
  } else {
    query.phone = phone;
  }

  let customer = await Customer.findOne(query);

  if (!customer) {
    const crn = await generateCRN();
    customer = new Customer({
      crn,
      name: name || "Anonymous Visitor",
      email: resolvedEmail,
      phone: phone || null,
      websiteId,
      leadSource: data.leadSource || "Manual",
      ownerId: data.ownerId || null
    });
    await customer.save();
    await incrementCustomers(websiteId);
    logger.log(`[CRN_SYSTEM]: Created customer ${crn} for ${name || "anonymous visitor"}`);
  } else {
    // Update last interaction and fill missing identity details
    customer.lastInteraction = new Date();
    if (name && (!customer.name || customer.name === "Anonymous Visitor")) {
      customer.name = name;
    }
    // If visitor now provides real email but had placeholder, upgrade it
    if (email && customer.email?.endsWith("@visitor.local")) {
      customer.email = email;
    }
    if (phone && !customer.phone) {
      customer.phone = phone;
    }
    await customer.save();
  }

  return customer;
};

export async function findDefaultCrmOwner({ websiteId, managerId }) {
  const onlineQuery = {
    managerId,
    isOnline: true,
    isAvailable: true,
    role: { $in: ["sales", "manager"] },
    $or: [
      { websiteIds: websiteId },
      { websiteIds: { $exists: false } },
      { websiteIds: { $size: 0 } }
    ]
  };

  let owner = await User.findOne(onlineQuery).sort({ lastActiveAt: -1, createdAt: 1 }).select("_id");
  if (!owner) {
    owner = await User.findOne({
      managerId,
      role: { $in: ["sales", "manager"] },
      $or: [
        { websiteIds: websiteId },
        { websiteIds: { $exists: false } },
        { websiteIds: { $size: 0 } }
      ]
    }).sort({ createdAt: 1 }).select("_id");
  }

  return owner?._id || null;
}
