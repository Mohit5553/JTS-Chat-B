/**
 * attachOwnedWebsiteIds middleware
 *
 * Resolves the list of website IDs the current authenticated user is allowed
 * to access and attaches it to `req.ownedWebsiteIds`. This avoids calling
 * getOwnedWebsiteIds() repeatedly inside each controller function.
 *
 * Must be placed AFTER requireAuth so that req.user is already set.
 *
 * Usage in a route file:
 *   import { attachOwnedWebsiteIds } from "../middleware/attachOwnedWebsiteIds.js";
 *   router.use(requireAuth, attachOwnedWebsiteIds);
 */
import { getOwnedWebsiteIds } from "../utils/roleUtils.js";

export const attachOwnedWebsiteIds = async (req, res, next) => {
  try {
    if (!req.user) return next(); // nothing to do if not authenticated
    req.ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
    next();
  } catch (err) {
    next(err);
  }
};
