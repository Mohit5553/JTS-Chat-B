import { User } from "../models/User.js";
import { ChatSession } from "../models/ChatSession.js";

const MAX_CONCURRENT_CHATS = 5;

function normalizeCategory(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Optimized Assignment Service
 * Picks the agent with the lowest workload using a single batch query.
 */
export async function findAvailableAgent({ managerId, websiteId, category = "", roles = ["agent"] }) {
  const normalizedCategory = normalizeCategory(category);
  const baseQuery = {
    role: { $in: roles },
    managerId,
    websiteIds: websiteId,
    isOnline: true,
    isAvailable: true
  };

  // 1. Get all online and available agents for this website in one go
  let agents = await User.find(
    normalizedCategory
      ? {
          ...baseQuery,
          $or: [
            { department: normalizedCategory },
            { assignedCategories: normalizedCategory }
          ]
        }
      : baseQuery
  ).select("_id name department assignedCategories").lean();

  if (agents.length === 0 && normalizedCategory) {
    agents = await User.find(baseQuery).select("_id name department assignedCategories").lean();
  }

  if (agents.length === 0) return null;

  const agentIds = agents.map(a => a._id);

  // 2. Aggregate active session counts for all these agents
  const sessions = await ChatSession.aggregate([
    { $match: { assignedAgent: { $in: agentIds }, status: "active" } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } }
  ]);

  const workloadMap = Object.fromEntries(
    sessions.map(s => [s._id.toString(), s.count])
  );

  // 3. Select the best agent manually to avoid per-agent FindById
  let bestAgent = null;
  let minWorkload = Infinity;

  for (const agent of agents) {
    const currentWorkload = workloadMap[agent._id.toString()] || 0;
    const maxAllowed = MAX_CONCURRENT_CHATS;

    if (currentWorkload < minWorkload && currentWorkload < maxAllowed) {
      minWorkload = currentWorkload;
      bestAgent = agent;
    }
  }

  return bestAgent;
}
