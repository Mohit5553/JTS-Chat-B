import { Customer } from "../models/Customer.js";
import { Analytics } from "../models/Analytics.js";
import { Quotation } from "../models/Quotation.js";

/**
 * Calculates Customer Lifetime Value (LTV) for a given customer.
 * Logic: Sum of all won deal values + sum of all accepted quotations.
 */
export async function calculateCustomerLTV(customerId) {
  const customer = await Customer.findById(customerId);
  if (!customer) return 0;

  const wonDealsValue = customer.recordType === "customer" ? customer.leadValue : 0;
  
  const quotations = await Quotation.find({ 
    customerId, 
    status: "accepted" 
  });
  
  const quotesValue = quotations.reduce((sum, q) => sum + (q.total || 0), 0);

  return wonDealsValue + quotesValue;
}

/**
 * Updates Marketing Analytics for CAC (Customer Acquisition Cost) calculations.
 * CAC = totalSpend / totalAcquired
 */
export async function updateFinancialAnalytics(websiteId, { spendChange = 0 } = {}) {
  let analytics = await Analytics.findOne({ websiteId });
  if (!analytics) {
     analytics = new Analytics({ websiteId });
  }

  // Use metadata or extension fields in Analytics if they don't exist yet
  // For this exercise, we assume spend is tracked in a metadata Map or extension fields.
  const currentSpend = Number(analytics.get ? analytics.get("totalMarketingSpend") : 0) || 0;
  const newSpend = currentSpend + spendChange;

  if (analytics.set) {
    analytics.set("totalMarketingSpend", newSpend.toString());
  }

  const customersCount = await Customer.countDocuments({ websiteId, recordType: "customer", archivedAt: null });
  
  if (customersCount > 0) {
    const cac = newSpend / customersCount;
    if (analytics.set) analytics.set("cac", cac.toFixed(2));
  }

  await analytics.save();
  return analytics;
}

/**
 * Summarizes the financial performance of a pipeline.
 */
export async function getPipelineFinanceSummary(websiteId) {
  const results = await Customer.aggregate([
    { $match: { websiteId, archivedAt: null } },
    { $group: {
        _id: "$recordType",
        totalValue: { $sum: "$leadValue" },
        count: { $sum: 1 }
    }}
  ]);

  const quotations = await Quotation.aggregate([
    { $match: { websiteId, status: "accepted" } },
    { $group: { _id: null, total: { $sum: "$total" } } }
  ]);

  const summary = {
    leadsValue: 0,
    dealsValue: 0,
    customerEquity: 0,
    acceptedQuotes: quotations[0]?.total || 0
  };

  results.forEach(r => {
    if (r._id === "lead") summary.leadsValue = r.totalValue;
    if (r._id === "deal") summary.dealsValue = r.totalValue;
    if (r._id === "customer") summary.customerEquity = r.totalValue;
  });

  return summary;
}
