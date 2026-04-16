import { Analytics } from "../models/Analytics.js";
import { AnalyticsSnapshot } from "../models/AnalyticsSnapshot.js";

function truncateHour(date) {
  const d = new Date(date || Date.now());
  d.setMinutes(0, 0, 0);
  return d;
}

export async function ensureAnalytics(websiteId) {
  return Analytics.findOneAndUpdate(
    { websiteId },
    { $setOnInsert: { websiteId } },
    { upsert: true, new: true }
  );
}

async function ensureSnapshot(websiteId) {
  const hour = truncateHour();
  return AnalyticsSnapshot.findOneAndUpdate(
    { websiteId, hour },
    { $setOnInsert: { websiteId, hour } },
    { upsert: true, new: true }
  );
}

export async function incrementVisitors(websiteId) {
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { totalVisitors: 1 } });

  return Analytics.findOneAndUpdate(
    { websiteId },
    { $inc: { totalVisitors: 1 } },
    { upsert: true, new: true }
  );
}

export async function incrementCustomers(websiteId) {
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { totalCustomers: 1 } });

  return Analytics.findOneAndUpdate(
    { websiteId },
    { $inc: { totalCustomers: 1 } },
    { upsert: true, new: true }
  );
}

export async function addWonRevenue(websiteId, amount = 0) {
  const amt = Number(amount || 0);
  if (!amt) return await ensureAnalytics(websiteId);
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { totalRevenue: amt, conversions: 1 } });
  const analytics = await Analytics.findOneAndUpdate({ websiteId }, { $inc: { totalRevenue: amt, conversions: 1 } }, { upsert: true, new: true });
  return analytics;
}

export async function recordConversionTime(websiteId, seconds = 0) {
  const secs = Number(seconds || 0);
  if (!secs) return await ensureAnalytics(websiteId);
  await ensureSnapshot(websiteId);
  // Update snapshot totals
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { conversions: 1 }, $set: { avgConversionTimeSeconds: secs } });

  const analytics = await ensureAnalytics(websiteId);
  const prevCount = analytics.conversions || 0;
  const prevAvg = analytics.avgConversionTimeSeconds || 0;
  const nextAvg = prevCount === 0 ? secs : ((prevAvg * prevCount) + secs) / (prevCount + 1);
  analytics.avgConversionTimeSeconds = Number(nextAvg.toFixed(2));
  analytics.conversions = prevCount + 1;
  await analytics.save();
  return analytics;
}

export async function incrementActiveChats(websiteId, delta = 1) {
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { activeChats: delta } });

  return Analytics.findOneAndUpdate(
    { websiteId },
    { $inc: { activeChats: delta } },
    { upsert: true, new: true }
  );
}

export async function incrementResolvedChats(websiteId) {
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $inc: { resolvedChats: 1 } });

  return Analytics.findOneAndUpdate(
    { websiteId },
    { $inc: { resolvedChats: 1, activeChats: -1 } },
    { upsert: true, new: true }
  );
}

export async function updateAverageResponseTime(websiteId, responseSeconds) {
  const analytics = await ensureAnalytics(websiteId);
  const resolved = analytics.resolvedChats || 0;
  const current = analytics.avgResponseTimeSeconds || 0;
  const next = resolved <= 1 ? responseSeconds : ((current * (resolved - 1)) + responseSeconds) / resolved;

  analytics.avgResponseTimeSeconds = Number(next.toFixed(2));
  await analytics.save();

  // Also update snapshot
  await ensureSnapshot(websiteId);
  await AnalyticsSnapshot.updateOne({ websiteId, hour: truncateHour() }, { $set: { avgWaitTimeSeconds: responseSeconds } });

  return analytics;
}

