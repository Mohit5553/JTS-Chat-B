import { ChatSession } from "../models/ChatSession.js";
import { User } from "../models/User.js";
import { Visitor } from "../models/Visitor.js";
import { Website } from "../models/Website.js";
import { AnalyticsSnapshot } from "../models/AnalyticsSnapshot.js";

const OWNER_ROLES = ["admin", "client", "manager"];

function normalizeRole(role) {
  return role === "manager" ? "admin" : role;
}

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

async function getOwnedWebsiteIds(user) {
  const role = normalizeRole(user.role);
  if (role === "admin") {
    const websites = await Website.find({}).select("_id");
    return websites.map((website) => website._id);
  }

  if (role === "client") {
    const websites = await Website.find({ managerId: user._id }).select("_id");
    return websites.map((website) => website._id);
  }

  return [];
}

export async function getManagerAnalytics(req, res) {
  const role = normalizeRole(req.user.role);
  if (!OWNER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ message: "Access denied" });
  }

  const websiteFilter = role === "admin" ? {} : { managerId: req.user._id };
  const websites = await Website.find(websiteFilter).sort({ createdAt: -1 });
  const websiteIds = websites.map((website) => website._id);
  const agentFilter = role === "admin" ? { role: "agent" } : { role: "agent", managerId: req.user._id };

  const [
    agentCount, liveSessions, todaySessions, 
    currentMonthVisitors, totalVisitors, 
    satisfiedChats, unsatisfiedChats, 
    dailyChatVolume, monthlyVisitors, topCountries,
    slaMetrics, leaderboard, analyticsSnapshots
  ] = await Promise.all([
    User.countDocuments(agentFilter),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, status: { $in: ["active", "queued"] } }),
    ChatSession.countDocuments({
      websiteId: { $in: websiteIds },
      createdAt: { $gte: startOfDay(new Date()), $lte: endOfDay(new Date()) }
    }),
    Visitor.countDocuments({
      websiteId: { $in: websiteIds },
      firstVisitTime: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
    }),
    Visitor.countDocuments({ websiteId: { $in: websiteIds } }),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, satisfactionStatus: "satisfied" }),
    ChatSession.countDocuments({ websiteId: { $in: websiteIds }, satisfactionStatus: "unsatisfied" }),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, createdAt: { $gte: startOfDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)) } } },
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]),
    Visitor.aggregate([
      { $match: { websiteId: { $in: websiteIds }, firstVisitTime: { $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 5, 1) } } },
      { $group: { _id: { year: { $year: "$firstVisitTime" }, month: { $month: "$firstVisitTime" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]),
    Visitor.aggregate([
      { $match: { websiteId: { $in: websiteIds } } },
      { $group: { _id: "$country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, acceptedAt: { $ne: null } } },
      { $group: {
          _id: null,
          avgWaitTimeMs: { $avg: { $subtract: ["$acceptedAt", "$createdAt"] } },
          avgHandleTimeMs: { 
            $avg: { 
              $cond: [ { $ne: ["$closedAt", null] }, { $subtract: ["$closedAt", "$acceptedAt"] }, null ] 
            } 
          }
        }
      }
    ]),
    ChatSession.aggregate([
      { $match: { websiteId: { $in: websiteIds }, assignedAgent: { $ne: null } } },
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
      hour: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } 
    }).sort({ hour: 1 })
  ]);

  const totalFeedback = satisfiedChats + unsatisfiedChats;

  return res.json({
    totals: {
      websites: websites.length,
      agents: agentCount,
      liveSessions,
      dailyChats: todaySessions,
      totalMonthlyVisitors: currentMonthVisitors,
      totalVisitors
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
  const role = normalizeRole(req.user.role);
  const websiteFilter = role === "admin" ? {} : { managerId: req.user._id };
  const websites = await Website.find(websiteFilter);
  const websiteIds = websites.map((w) => w._id);

  const sessions = await ChatSession.find({ websiteId: { $in: websiteIds } })
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
