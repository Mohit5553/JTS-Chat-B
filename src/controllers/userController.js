import { z } from "zod";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Website } from "../models/Website.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";


const OWNER_ROLES = ["admin", "client", "manager"];

function normalizeRole(role) {
  return role === "manager" ? "admin" : role;
}

export async function createAgent(req, res) {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });

  if (existing) {
    return res.status(409).json({ message: "Email already in use" });
  }

  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.default.hash(password, 10);
  const agent = await User.create({
    name,
    email,
    password: hashedPassword,
    role: "agent",
    managerId: req.user._id
  });

  return res.status(201).json({
    id: agent._id,
    _id: agent._id,
    name: agent.name,
    email: agent.email,
    role: agent.role,
    managerId: agent.managerId,
    isOnline: agent.isOnline,
    isAvailable: agent.isAvailable
  });
}

export async function listAgents(req, res) {
  const filter = normalizeRole(req.user.role) === "admin"
    ? { role: "agent" }
    : { role: "agent", managerId: req.user._id };

  const agents = await User.find(filter).select("-password").populate("managerId", "name email").sort({ createdAt: -1 });
  return res.json(agents.map((agent) => ({ ...agent.toObject(), role: normalizeRole(agent.role) })));
}

export async function listClients(req, res) {
  if (normalizeRole(req.user.role) !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  const clients = await User.find({ role: "client" }).select("-password").sort({ createdAt: -1 });
  
  const enhancedClients = await Promise.all(clients.map(async (client) => {
     const websiteCount = await Website.countDocuments({ managerId: client._id });
     const agentCount = await User.countDocuments({ role: "agent", managerId: client._id });
     return { ...client.toObject(), websiteCount, agentCount };
  }));
  
  return res.json(enhancedClients);
}

export async function createClient(req, res) {
  if (normalizeRole(req.user.role) !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }

  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.status(409).json({ message: "Email in use" });

  const bcrypt = await import("bcryptjs");
  const hashedPassword = await bcrypt.default.hash(password, 10);

  const client = await User.create({
    name,
    email,
    password: hashedPassword,
    role: "client"
  });

  return res.status(201).json({
    id: client._id,
    _id: client._id,
    name: client.name,
    email: client.email,
    role: client.role
  });
}

export const updateAvailability = asyncHandler(async (req, res) => {
  req.user.isOnline = req.body.isOnline ?? req.user.isOnline;
  req.user.isAvailable = req.body.isAvailable ?? req.user.isAvailable;
  req.user.lastActiveAt = new Date();
  await req.user.save();
  return res.json({ ...req.user.toObject(), role: normalizeRole(req.user.role) });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(2, "Name is too short"),
    email: z.string().email("Invalid email"),
    password: z.string().min(8, "Password must be at least 8 characters").optional().or(z.literal(''))
  });

  const parsed = schema.parse(req.body);
  
  if (parsed.email !== req.user.email) {
    const existing = await User.findOne({ email: parsed.email });
    if (existing) throw new AppError("Email is already in use by another account", 409);
  }

  req.user.name = parsed.name;
  req.user.email = parsed.email;

  if (parsed.password) {
    req.user.password = await bcrypt.hash(parsed.password, 12);
  }

  await req.user.save();
  
  const updatedUser = req.user.toObject();
  delete updatedUser.password;
  updatedUser.role = normalizeRole(updatedUser.role);
  
  return res.json(updatedUser);
});

export const updateAgent = asyncHandler(async (req, res) => {
  const filter = normalizeRole(req.user.role) === "admin"
    ? { _id: req.params.id, role: "agent" }
    : { _id: req.params.id, role: "agent", managerId: req.user._id };

  const agent = await User.findOne(filter);
  if (!agent) throw new AppError("Agent not found", 404);

  const { name, email, password } = req.body;
  if (name) agent.name = name;
  if (email && email !== agent.email) {
    const existing = await User.findOne({ email });
    if (existing) throw new AppError("Email in use", 409);
    agent.email = email;
  }
  if (password) {
    agent.password = await bcrypt.hash(password, 12);
  }

  await agent.save();
  return res.json({ _id: agent._id, name: agent.name, email: agent.email, role: normalizeRole(agent.role) });
});

export const deleteAgent = asyncHandler(async (req, res) => {
  const filter = normalizeRole(req.user.role) === "admin"
    ? { _id: req.params.id, role: "agent" }
    : { _id: req.params.id, role: "agent", managerId: req.user._id };

  const result = await User.deleteOne(filter);
  if (result.deletedCount === 0) throw new AppError("Agent not found", 404);
  return res.json({ message: "Agent deleted" });
});

