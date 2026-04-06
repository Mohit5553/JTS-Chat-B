import { User } from "../models/User.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { hasModuleAccess, resolveSubscriptionForUser } from "../utils/planUtils.js";

async function getTenantUser(user) {
  if (!user) return null;
  if (user.role === "admin" || user.role === "client") return user;
  if (!user.managerId) return user;
  return User.findById(user.managerId).select("role subscription");
}

export const attachTenantSubscription = asyncHandler(async (req, _res, next) => {
  const tenantUser = await getTenantUser(req.user);
  req.tenantUser = tenantUser;
  req.subscription = resolveSubscriptionForUser(tenantUser || req.user);
  next();
});

export function requirePlanFeature(moduleName) {
  return asyncHandler(async (req, _res, next) => {
    if (!req.subscription) {
      const tenantUser = await getTenantUser(req.user);
      req.tenantUser = tenantUser;
      req.subscription = resolveSubscriptionForUser(tenantUser || req.user);
    }

    if (!hasModuleAccess(req.subscription, moduleName)) {
      throw new AppError(`Your current plan does not include ${moduleName}.`, 403);
    }

    next();
  });
}
