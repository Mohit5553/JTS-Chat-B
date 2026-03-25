import { CannedResponse } from "../models/CannedResponse.js";

function getManagerId(user) {
  // If user is client, they are the manager. 
  // If user is agent, their managerId is the client.
  // If user is admin (owner/global), they manage their own too or we can shared. 
  // For simplicity, let's say agents use their client's shortcuts.
  if (user.role === "client") return user._id;
  if (user.role === "agent") return user.managerId;
  return user._id; 
}

export async function listCannedResponses(req, res) {
  const managerId = getManagerId(req.user);
  const responses = await CannedResponse.find({ managerId }).sort({ shortcut: 1 });
  return res.json(responses);
}

export async function createCannedResponse(req, res) {
  const { shortcut, content } = req.body;
  if (!shortcut || !content) {
    return res.status(400).json({ message: "Shortcut and content required" });
  }

  const managerId = getManagerId(req.user);
  const existing = await CannedResponse.findOne({ managerId, shortcut: shortcut.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: "Shortcut already exists" });
  }

  const response = await CannedResponse.create({
    shortcut: shortcut.toLowerCase().replace("/", ""),
    content,
    managerId
  });

  return res.status(201).json(response);
}

export async function deleteCannedResponse(req, res) {
  const managerId = getManagerId(req.user);
  const response = await CannedResponse.findOneAndDelete({ _id: req.params.id, managerId });
  if (!response) {
    return res.status(404).json({ message: "Response not found" });
  }
  return res.json({ success: true });
}
