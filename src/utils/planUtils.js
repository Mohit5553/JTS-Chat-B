export const PLAN_DEFINITIONS = Object.freeze({
  basic: {
    plan: "basic",
    enabledModules: ["chat", "shortcuts", "security"],
    limits: { agents: 2, websites: 1 }
  },
  standard: {
    plan: "standard",
    enabledModules: ["chat", "tickets", "shortcuts", "reports", "security"],
    limits: { agents: 5, websites: 2 }
  },
  pro: {
    plan: "pro",
    enabledModules: ["chat", "tickets", "crm", "shortcuts", "reports", "security"],
    limits: { agents: 20, websites: 10 }
  }
});

export function normalizePlan(plan = "pro") {
  return PLAN_DEFINITIONS[plan] ? plan : "pro";
}

export function buildSubscription(plan = "pro", overrides = {}) {
  const normalizedPlan = normalizePlan(plan);
  const definition = PLAN_DEFINITIONS[normalizedPlan];

  return {
    plan: normalizedPlan,
    status: overrides.status || "active",
    enabledModules: overrides.enabledModules || [...definition.enabledModules],
    limits: {
      ...definition.limits,
      ...(overrides.limits || {})
    }
  };
}

export function resolveSubscriptionForUser(user) {
  if (user?.role === "admin") {
    return buildSubscription("pro");
  }

  const subscription = user?.subscription || {};
  const plan = normalizePlan(subscription.plan || "pro");
  const definition = PLAN_DEFINITIONS[plan];

  return {
    plan,
    status: subscription.status || "active",
    enabledModules: Array.isArray(subscription.enabledModules) && subscription.enabledModules.length
      ? subscription.enabledModules
      : [...definition.enabledModules],
    limits: {
      ...definition.limits,
      ...(subscription.limits || {})
    }
  };
}

export function hasModuleAccess(subscription, moduleName) {
  if (!subscription) return false;
  if (subscription.status === "suspended" || subscription.status === "expired") return false;
  return Array.isArray(subscription.enabledModules) && subscription.enabledModules.includes(moduleName);
}
