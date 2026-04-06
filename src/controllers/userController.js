import { z } from "zod";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { normalizeRole } from "../utils/roleUtils.js";
import { buildSubscription, resolveSubscriptionForUser } from "../utils/planUtils.js";

const createUserSchema = z.object({
  name: z.string().min(2, "Name is too short"),
  email: z.string().email("Invalid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  websiteIds: z.array(z.string()).optional().default([]),
  department: z.string().min(1, "Department is required").optional().default("general"),
  assignedCategories: z.array(z.string()).optional().default([])
});

async function ensureUniqueEmail(email, currentUserId = null) {
  const existing = await User.findOne({ email });
  if (existing && String(existing._id) !== String(currentUserId || "")) {
    throw new AppError("Email already in use", 409);
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function resolveOwnedWebsiteIdsForCreator(user) {
  if (normalizeRole(user.role) === "admin") {
    const websites = await Website.find({}).select("_id");
    return websites.map((website) => website._id.toString());
  }

  const parentId = user.role === "client" ? user._id : user.managerId;
  const websites = await Website.find({ managerId: parentId }).select("_id");
  return websites.map((website) => website._id.toString());
}

async function sanitizeAssignedWebsiteIds(requestedWebsiteIds, creator) {
  const uniqueIds = [...new Set((requestedWebsiteIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const ownedIds = await resolveOwnedWebsiteIdsForCreator(creator);
  const invalidId = uniqueIds.find((id) => !ownedIds.includes(String(id)));
  if (invalidId) {
    throw new AppError("Selected website is outside your account scope", 403);
  }

  return uniqueIds;
}

async function resolveManagerIdForPersonnel(creator, assignedWebsiteIds) {
  if (creator.role === "client") {
    return creator._id;
  }

  if (creator.role === "admin") {
    if (assignedWebsiteIds.length === 0) {
      throw new AppError("At least one website assignment is required", 400);
    }
    const websites = await Website.find({ _id: { $in: assignedWebsiteIds } }).select("managerId");
    const managerIds = [...new Set(websites.map((website) => String(website.managerId || "")))].filter(Boolean);
    if (managerIds.length !== 1) {
      throw new AppError("Selected websites must belong to the same client account", 400);
    }
    return managerIds[0];
  }

  return creator.managerId;
}


export const createAgent = asyncHandler(async (req, res) => {
  const { name, email, password, websiteIds, department, assignedCategories } = createUserSchema.parse(req.body);
  const role = ["agent", "manager", "user", "sales"].includes(req.body.role) ? req.body.role : "agent";
  await ensureUniqueEmail(email);
  const hashedPassword = await hashPassword(password);
  const assignedWebsiteIds = await sanitizeAssignedWebsiteIds(websiteIds, req.user);
  if (assignedWebsiteIds.length === 0) {
    throw new AppError("Please assign at least one website", 400);
  }
  const managerId = await resolveManagerIdForPersonnel(req.user, assignedWebsiteIds);
  const tenant = req.user.role === "client" ? req.user : await User.findById(managerId).select("subscription");
  const subscription = resolveSubscriptionForUser(tenant);
  const personnelCount = await User.countDocuments({ managerId, role: { $in: ["agent", "manager", "user", "sales"] } });
  if (personnelCount >= (subscription.limits?.agents || 0)) {
    throw new AppError(`Your ${subscription.plan} plan allows up to ${subscription.limits?.agents || 0} personnel accounts.`, 403);
  }
  const agent = await User.create({
    name,
    email,
    password: hashedPassword,
    role,
    department,
    assignedCategories,
    managerId,
    websiteIds: assignedWebsiteIds
  });

  return res.status(201).json({
    id: agent._id,
    _id: agent._id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    department: agent.department,
    assignedCategories: agent.assignedCategories,
    managerId: agent.managerId,
    websiteIds: agent.websiteIds,
    isOnline: agent.isOnline,
    isAvailable: agent.isAvailable
  });
});

export const listAgents = asyncHandler(async (req, res) => {
  const parentId = req.user.role === "client" ? req.user._id : req.user.managerId;
  const filter = normalizeRole(req.user.role) === "admin"
    ? { role: { $in: ["agent", "manager", "user", "sales"] } }
    : { role: { $in: ["agent", "manager", "user", "sales"] }, managerId: parentId };

  if (req.user.role === "manager" && Array.isArray(req.user.websiteIds) && req.user.websiteIds.length > 0) {
    filter.websiteIds = { $in: req.user.websiteIds };
  }

  const agents = await User.find(filter)
    .select("-password")
    .populate("managerId", "name email")
    .populate("websiteIds", "websiteName domain")
    .sort({ createdAt: -1 });

  const { ChatSession } = await import("../models/ChatSession.js");
  const enhancedAgents = await Promise.all(agents.map(async (agent) => {
    const activeChats = await ChatSession.countDocuments({ 
      assignedAgent: agent._id, 
      status: "active" 
    });
    return { ...agent.toObject(), activeChats };
  }));

  return res.json(enhancedAgents);
});

export const listClients = asyncHandler(async (req, res) => {
  if (normalizeRole(req.user.role) !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  const clients = await User.find({ role: "client" }).select("-password").sort({ createdAt: -1 });
  
  const enhancedClients = await Promise.all(clients.map(async (client) => {
     const websiteCount = await Website.countDocuments({ managerId: client._id });
     const agentCount = await User.countDocuments({ role: "agent", managerId: client._id });
     return { ...client.toObject(), websiteCount, agentCount, subscription: resolveSubscriptionForUser(client) };
  }));
  
  return res.json(enhancedClients);
});

export const createClient = asyncHandler(async (req, res) => {
  if (normalizeRole(req.user.role) !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }

  const { name, email, password } = createUserSchema.parse(req.body);
  const requestedPlan = ["basic", "standard", "pro"].includes(req.body.plan) ? req.body.plan : "pro";
  await ensureUniqueEmail(email);
  const hashedPassword = await hashPassword(password);

  const client = await User.create({
    name,
    email,
    password: hashedPassword,
    role: "client",
    subscription: buildSubscription(requestedPlan)
  });

  return res.status(201).json({
    id: client._id,
    _id: client._id,
    name: client.name,
    email: client.email,
    role: client.role,
    subscription: resolveSubscriptionForUser(client)
  });
});

export const updateAvailability = asyncHandler(async (req, res) => {
  req.user.isOnline = req.body.isOnline ?? req.user.isOnline;
  req.user.isAvailable = req.body.isAvailable ?? req.user.isAvailable;
  req.user.lastActiveAt = new Date();
  await req.user.save();
  const tenant = req.user.role === "client" || req.user.role === "admin"
    ? req.user
    : await User.findById(req.user.managerId).select("subscription role");
  return res.json({ ...req.user.toObject(), subscription: resolveSubscriptionForUser(tenant || req.user) });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(2, "Name is too short"),
    email: z.string().email("Invalid email"),
    password: z.string().min(6, "Password must be at least 6 characters").optional().or(z.literal(''))
  });

  const parsed = schema.parse(req.body);
  
  if (parsed.email !== req.user.email) {
    await ensureUniqueEmail(parsed.email, req.user._id);
  }

  req.user.name = parsed.name;
  req.user.email = parsed.email;

  if (parsed.password) {
    req.user.password = await hashPassword(parsed.password);
  }

  await req.user.save();
  
  const updatedUser = req.user.toObject();
  delete updatedUser.password;
  const tenant = req.user.role === "client" || req.user.role === "admin"
    ? req.user
    : await User.findById(req.user.managerId).select("subscription role");
  updatedUser.subscription = resolveSubscriptionForUser(tenant || req.user);
  
  return res.json(updatedUser);
});

export const updateAgent = asyncHandler(async (req, res) => {
  const parentId = req.user.role === "client" ? req.user._id : req.user.managerId;
  const filter = normalizeRole(req.user.role) === "admin"
    ? { _id: req.params.id, role: { $in: ["agent", "manager", "user", "sales"] } }
    : { _id: req.params.id, role: { $in: ["agent", "manager", "user", "sales"] }, managerId: parentId };

  const agent = await User.findOne(filter);
  if (!agent) throw new AppError("Personnel not found", 404);

  const { name, email, password, role, websiteIds, department, assignedCategories } = req.body;
  if (name) agent.name = name;
  if (email && email !== agent.email) {
    await ensureUniqueEmail(email, agent._id);
    agent.email = email;
  }
  if (password) {
    agent.password = await hashPassword(password);
  }
  if (role && ["agent", "manager", "user", "sales"].includes(role)) {
    agent.role = role;
  }
  if (department) {
    agent.department = String(department).trim().toLowerCase();
  }
  if (assignedCategories !== undefined) {
    agent.assignedCategories = Array.isArray(assignedCategories) ? assignedCategories : [];
  }
  if (websiteIds !== undefined) {
    const assignedWebsiteIds = await sanitizeAssignedWebsiteIds(Array.isArray(websiteIds) ? websiteIds : [], req.user);
    if (assignedWebsiteIds.length === 0) {
      throw new AppError("Please assign at least one website", 400);
    }
    agent.websiteIds = assignedWebsiteIds;
    if (req.user.role === "admin") {
      agent.managerId = await resolveManagerIdForPersonnel(req.user, assignedWebsiteIds);
    }
  }

  await agent.save();
  return res.json({
    _id: agent._id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    department: agent.department,
    assignedCategories: agent.assignedCategories,
    websiteIds: agent.websiteIds
  });
});

export const deleteAgent = asyncHandler(async (req, res) => {
  const parentId = req.user.role === "client" ? req.user._id : req.user.managerId;
  const filter = normalizeRole(req.user.role) === "admin"
    ? { _id: req.params.id, role: { $in: ["agent", "manager", "user", "sales"] } }
    : { _id: req.params.id, role: { $in: ["agent", "manager", "user", "sales"] }, managerId: parentId };

  const result = await User.deleteOne(filter);
  if (result.deletedCount === 0) throw new AppError("Personnel not found", 404);
  return res.json({ message: "Personnel deleted" });
});

export const getClientDetails = asyncHandler(async (req, res) => {
  if (normalizeRole(req.user.role) !== "admin") {
    throw new AppError("Admin access required", 403);
  }

  const client = await User.findOne({ _id: req.params.id, role: "client" }).select("-password");
  if (!client) throw new AppError("Client not found", 404);

  const websites = await Website.find({ managerId: client._id }).sort({ createdAt: -1 });
  const websiteIds = websites.map(w => w._id);

  const personnel = await User.find({ managerId: client._id, role: { $in: ["agent", "manager", "user", "sales"] } })
    .select("-password")
    .populate("websiteIds", "websiteName domain")
    .sort({ createdAt: -1 });

  const { ChatSession } = await import("../models/ChatSession.js");
  const { Visitor } = await import("../models/Visitor.js");

  const chats = await ChatSession.find({ websiteId: { $in: websiteIds } })
    .populate("assignedAgent", "name email")
    .populate("websiteId", "websiteName domain")
    .populate("visitorId", "name email visitorId")
    .sort({ createdAt: -1 })
    .limit(50);

  const visitors = await Visitor.find({ websiteId: { $in: websiteIds } })
    .sort({ lastActive: -1, createdAt: -1 })
    .limit(50);

  return res.json({
    client: { ...client.toObject(), subscription: resolveSubscriptionForUser(client) },
    websites,
    personnel,
    chats,
    visitors
  });
});

