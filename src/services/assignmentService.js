import { User } from "../models/User.js";
import { ChatSession } from "../models/ChatSession.js";

const MAX_WORKLOAD = 10;

/**
 * Professional Assignment: Workload-based
 * Picks the agent with the fewest active chat sessions.
 */
export async function findAvailableAgent(managerId) {
  // 1. Get all online and available agents for this client
  const onlineAgents = await User.find({
    role: "agent",
    managerId,
    isOnline: true,
    isAvailable: true
  }).select("_id");

  if (onlineAgents.length === 0) return null;

  const agentIds = onlineAgents.map(a => a._id);

  // 2. Count active sessions per agent
  const sessions = await ChatSession.aggregate([
    { $match: { assignedAgent: { $in: agentIds }, status: "active" } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } }
  ]);

  // Create a map of active counts
  const workloadMap = {};
  sessions.forEach(s => workloadMap[s._id.toString()] = s.count);

  // 3. Find the agent with the lowest workload
  let bestAgentId = null;
  let minWorkload = Infinity;

  // We should prefer agents who are not yet in the workloadMap (workload = 0)
  for (const agent of onlineAgents) {
    const currentWorkload = workloadMap[agent._id.toString()] || 0;
    if (currentWorkload < minWorkload && currentWorkload < MAX_WORKLOAD) {
      minWorkload = currentWorkload;
      bestAgentId = agent._id;
    }
  }

  if (!bestAgentId) return null;

  return User.findById(bestAgentId);
}
