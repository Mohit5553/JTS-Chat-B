/**
 * Shared role utilities — centralised here to avoid duplication across controllers/sockets.
 */
import { Website } from "../models/Website.js";

/**
 * Normalises legacy aliases (e.g., user or sales to agent).
 * Manager is a distinct role representing a tenant-level admin.
 * @param {string} role
 * @returns {string}
 */
export function normalizeRole(role) {
  if (role === "user" || role === "sales") return "agent";
  return role;
}

function sanitizeWebsiteIds(ids = []) {
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

/**
 * Returns the list of Website ObjectIds that the given user is allowed to access.
 * - Admins can see all websites.
 * - Clients only see websites they manage.
 * - Managers only see websites belonging to their parent client (managerId).
 * - Agents get an empty array (they work per-session, not per-website).
 *
 * @param {object} user - Mongoose User document (or plain object with .role, ._id, .managerId)
 * @returns {Promise<import("mongoose").Types.ObjectId[]>}
 */
export async function getOwnedWebsiteIds(user) {
  const rawRole = user.role;
  const role = normalizeRole(rawRole);

  if (role === "admin") {
    // Global admin: all websites
    const websites = await Website.find({}).select("_id");
    return websites.map((w) => w._id);
  }

  if (role === "client") {
    // Client: websites they own
    const websites = await Website.find({ managerId: user._id }).select("_id");
    return websites.map((w) => w._id);
  }

  if (role === "manager") {
    const assigned = sanitizeWebsiteIds(user.websiteIds);
    if (assigned.length > 0) return assigned;
    const websites = await Website.find({ managerId: user.managerId }).select("_id");
    return websites.map((w) => w._id);
  }

  if (["sales", "agent", "user"].includes(rawRole)) {
    const assigned = sanitizeWebsiteIds(user.websiteIds);
    if (assigned.length > 0) return assigned;
    const websites = await Website.find({ managerId: user.managerId }).select("_id");
    return websites.map((w) => w._id);
  }

  return [];
}
