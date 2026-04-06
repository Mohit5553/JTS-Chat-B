import { ChatSession } from "../models/ChatSession.js";
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { Visitor } from "../models/Visitor.js";
import { Website } from "../models/Website.js";
import { AnalyticsSnapshot } from "../models/AnalyticsSnapshot.js";
import { Ticket } from "../models/Ticket.js";
import { normalizeRole, getOwnedWebsiteIds } from "../utils/roleUtils.js";



const OWNER_ROLES = ["admin", "client", "manager"];

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function resolveDateRange(query) {
  const now = new Date();
  const rawStart = query.startDate ? new Date(query.startDate) : null;
  const rawEnd = query.endDate ? new Date(query.endDate) : null;

  const end = rawEnd && !Number.isNaN(rawEnd.getTime()) ? endOfDay(rawEnd) : endOfDay(now);
  const fallbackStart = new Date(end);
  fallbackStart.setDate(fallbackStart.getDate() - 6);
  let start = rawStart && !Number.isNaN(rawStart.getTime()) ? startOfDay(rawStart) : startOfDay(fallbackStart);

  if (start > end) {
    start = startOfDay(end);
  }

  return { start, end };
}


export async function getManagerAnalytics(req, res) {
  const role = normalizeRole(req.user.role);
  if (!OWNER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Access denied" });
  }

  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);
  const { websiteId } = req.query;
  const { start, end } = resolveDateRange(req.query);

  let websiteFilter = { _id: { $in: ownedWebsiteIds } };
  if (websiteId) {
    if (!ownedWebsiteIds.map(id => id.toString()).includes(websiteId)) {
      return res.status(403).json({ message: "Access denied to this website" });
    }
    websiteFilter._id = websiteId;
  }
  
  const websites = await Website.find(websiteFilter).sort({ createdAt: -1 });
  const websiteIds = websites.map((w) => w._id);

  // If role is admin, show all agents. If client/manager, show personnel belonging to the parent client.
  const managerIdForAgents = req.user.role === "client" ? req.user._id : req.user.managerId;
  const agentFilter = req.user.role === "admin" 
    ? { role: { $in: ["agent", "manager", "user", "sales"] } } 
    : { role: { $in: ["agent", "manager", "user", "sales"] }, managerId: managerIdForAgents };

  const [
    agentCount, liveSessions, todaySessions, 
    rangeVisitors, totalVisitors, 
    satisfiedChats, unsatisfiedChats, 
    dailyChatVolume, monthlyVisitors, topCountries,
    slaMetrics, leaderboard, analyticsSnapshots,
    resolvedTicketsCount
  ] = await Promise.all([
    User.countDocuments(agentFilter),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, status: { $in: ["active", "queued"] } }),
    ChatSession.countDocuments({
      websiteId: { $in: websiteIds },
      createdAt: { $gte: start, $lte: end }
    }),
    Visitor.countDocuments({
      websiteId: { $in: websiteIds },
      firstVisitTime: { $gte: start, $lte: end }
    }),
    Visitor.countDocuments({ websiteId: { $in: websiteIds } }),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, satisfactionStatus: "satisfied", createdAt: { $gte: start, $lte: end } }),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, satisfactionStatus: "unsatisfied", createdAt: { $gte: start, $lte: end } }),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]),
    Visitor.aggregate([
      { $match: { websiteId: { $in: websiteIds }, firstVisitTime: { $gte: start, $lte: end } } },
      { $group: { _id: { year: { $year: "$firstVisitTime" }, month: { $month: "$firstVisitTime" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]),
    Visitor.aggregate([
      { $match: { websiteId: { $in: websiteIds }, firstVisitTime: { $gte: start, $lte: end } } },
      { $group: { _id: "$country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, acceptedAt: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
      { $group: {
          _id: null,
          avgWaitTimeMs: { $avg: { $subtract: ["$acceptedAt", "$createdAt"] } },
          avgResponseTimeMs: { 
            $avg: { 
              $cond: [ { $ne: ["$firstResponseAt", null] }, { $subtract: ["$firstResponseAt", "$acceptedAt"] }, null ] 
            } 
          },
          avgHandleTimeMs: { 
            $avg: { 
              $cond: [ { $ne: ["$closedAt", null] }, { $subtract: ["$closedAt", "$acceptedAt"] }, null ] 
            } 
          }
        }
      }
    ]),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, assignedAgent: { $ne: null }, createdAt: { $gte: start, $lte: end } } },
      { $group: { 
          _id: "$assignedAgent", 
          chatsHandled: { $sum: 1 },
          avgHandleSeconds: { 
            $avg: { 
              $cond: [ { $ne: ["$closedAt", null] }, { $divide: [{ $subtract: ["$closedAt", "$acceptedAt"] }, 1000] }, null ] 
            } 
          }
        } 
      },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "agent" } },
      { $unwind: "$agent" },
      { $project: { _id: 1, name: "$agent.name", email: "$agent.email", chatsHandled: 1, avgHandleSeconds: 1 } },
      { $sort: { chatsHandled: -1 } },
      { $limit: 10 }
    ]),
    AnalyticsSnapshot.find({ 
      websiteId: { $in: websiteIds }, 
      hour: { $gte: start, $lte: end } 
    }).sort({ hour: 1 }),
    Ticket.countDocuments({ websiteId: { $in: websiteIds }, status: "resolved", createdAt: { $gte: start, $lte: end } })
  ]);

  const totalFeedback = satisfiedChats + unsatisfiedChats;

  return res.json({
    totals: {
      websites: websites.length,
      agents: agentCount,
      liveSessions,
      dailyChats: todaySessions,
      totalMonthlyVisitors: rangeVisitors,
      totalVisitors,
      resolvedTickets: resolvedTicketsCount
    },
    meta: {
      startDate: start.toISOString(),
      endDate: end.toISOString()
    },
    topCountries: topCountries.map(c => ({ country: c._id, count: c.count })),
    feedback: {
      satisfiedChats,
      unsatisfiedChats,
      totalFeedback,
      satisfactionRate: totalFeedback ? Number(((satisfiedChats / totalFeedback) * 100).toFixed(1)) : 0
    },
    sla: {
      avgWaitTimeSeconds: slaMetrics[0]?.avgWaitTimeMs ? Math.round(slaMetrics[0].avgWaitTimeMs / 1000) : 0,
      avgResponseTimeSeconds: slaMetrics[0]?.avgResponseTimeMs ? Math.round(slaMetrics[0].avgResponseTimeMs / 1000) : 0,
      avgHandleTimeMinutes: slaMetrics[0]?.avgHandleTimeMs ? Number((slaMetrics[0].avgHandleTimeMs / (1000 * 60)).toFixed(1)) : 0
    },
    trends: {
      dailyChats: dailyChatVolume.map((entry) => ({ label: `${String(entry._id.day).padStart(2, "0")}/${String(entry._id.month).padStart(2, "0")}`, count: entry.count })),
      monthlyVisitors: monthlyVisitors.map((entry) => ({ label: `${String(entry._id.month).padStart(2, "0")}/${entry._id.year}`, count: entry.count })),
      hourly: analyticsSnapshots.map(s => ({
        time: s.hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        visitors: s.totalVisitors,
        chats: s.activeChats,
        resolved: s.resolvedChats
      }))
    },
    leaderboard,
    websites
  });
}

export async function exportAnalyticsCSV(req, res) {
  const { websiteId, agentId, startDate, endDate } = req.query;
  const ownedWebsiteIds = await getOwnedWebsiteIds(req.user);

  let websiteFilter = { _id: { $in: ownedWebsiteIds } };
  if (websiteId) {
    if (!ownedWebsiteIds.map(id => id.toString()).includes(websiteId)) {
      return res.status(403).json({ message: "Access denied to this website" });
    }
    websiteFilter._id = websiteId;
  }
  const websites = await Website.find(websiteFilter);
  const websiteIds = websites.map((w) => w._id);

  const sessionFilter = { websiteId: { $in: websiteIds } };
  if (agentId) sessionFilter.assignedAgent = agentId;
  if (startDate || endDate) {
    sessionFilter.createdAt = {};
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      sessionFilter.createdAt.$gte = start;
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      sessionFilter.createdAt.$lte = end;
    }
  }

  if (req.query.searchTerm) {
    const searchRegex = new RegExp(req.query.searchTerm, "i");
    const matchingVisitors = await Visitor.find({
      $or: [
        { name: searchRegex },
        { email: searchRegex },
        { visitorId: searchRegex }
      ]
    }).select("_id");
    
    const matchingMessages = await Message.find({
      message: searchRegex
    }).select("sessionId").distinct("sessionId");
    
    const visitorIds = matchingVisitors.map(v => v._id);

    sessionFilter.$or = [
      { lastMessagePreview: searchRegex },
      { visitorId: { $in: visitorIds } },
      { _id: { $in: matchingMessages } }
    ];
  }

  const sessions = await ChatSession.find(sessionFilter)
    .populate("websiteId", "websiteName")
    .populate("assignedAgent", "name email")
    .populate("visitorId", "name email")
    .sort({ createdAt: -1 });

  let csv = "Date,Website,Visitor Name,Visitor Email,Agent,Status,Satisfaction\n";
  sessions.forEach((s) => {
    const row = [
      s.createdAt.toISOString(),
      s.websiteId?.websiteName || "N/A",
      s.visitorId?.name || "Anonymous",
      s.visitorId?.email || "N/A",
      s.assignedAgent?.name || "Unassigned",
      s.status,
      s.satisfactionStatus || "None"
    ];
    csv += row.map((v) => `"${v}"`).join(",") + "\n";
  });

  res.setHeader("Content-Type", "text/csv");
  res.attachment(`chats_export_${new Date().toISOString().split("T")[0]}.csv`);
  return res.send(csv);
}
