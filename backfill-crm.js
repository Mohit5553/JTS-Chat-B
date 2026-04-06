/**
 * One-time backfill script: creates CRM Customer records for all existing
 * Visitor records that don't already have a CRN / customerId.
 *
 * Run with:  node backfill-crm.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

// ── Inline minimal models so this script is self-contained ──────────────────
const customerSchema = new mongoose.Schema(
  {
    crn:             { type: String, required: true, unique: true },
    name:            { type: String, required: true },
    email:           { type: String, required: true },
    phone:           { type: String },
    websiteId:       { type: mongoose.Schema.Types.ObjectId, ref: "Website", required: true },
    status:          { type: String, default: "prospect" },
    tags:            [String],
    internalNotes:   [{ text: String, authorName: String, createdAt: Date }],
    firstInteraction:{ type: Date, default: Date.now },
    lastInteraction: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

const visitorSchema = new mongoose.Schema(
  {
    visitorId:  { type: String, required: true },
    websiteId:  { type: mongoose.Schema.Types.ObjectId, required: true },
    name:       String,
    email:      String,
    phone:      String,
    ipAddress:  String,
    customerId: { type: mongoose.Schema.Types.ObjectId },
    crn:        String
  },
  { timestamps: true }
);

const analyticsSchema = new mongoose.Schema({ websiteId: mongoose.Schema.Types.ObjectId }, { strict: false });

const Customer  = mongoose.models.Customer  || mongoose.model("Customer",  customerSchema);
const Visitor   = mongoose.models.Visitor   || mongoose.model("Visitor",   visitorSchema);
const Analytics = mongoose.models.Analytics || mongoose.model("Analytics", analyticsSchema);

// ── CRN generator ──────────────────────────────────────────────────────────
async function generateCRN() {
  const year   = new Date().getFullYear();
  const prefix = `CRN-${year}-`;
  const last   = await Customer.findOne({ crn: new RegExp(`^${prefix}`) }).sort({ crn: -1 }).select("crn");
  let next = 1;
  if (last?.crn) next = parseInt(last.crn.split("-").pop(), 10) + 1;
  return `${prefix}${String(next).padStart(4, "0")}`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  // Find all visitors without a CRN
  const visitors = await Visitor.find({ crn: { $in: [null, undefined, ""] } });
  console.log(`📋 Found ${visitors.length} visitors without a CRM record`);

  let created = 0;
  let linked  = 0;
  let skipped = 0;

  for (const visitor of visitors) {
    const resolvedEmail = visitor.email
      || `anon-${visitor.visitorId}@visitor.local`;

    // Check if a customer already exists with this email in the same website
    let customer = await Customer.findOne({
      email: resolvedEmail,
      websiteId: visitor.websiteId
    });

    if (!customer) {
      // Also try phone
      if (visitor.phone) {
        customer = await Customer.findOne({ phone: visitor.phone, websiteId: visitor.websiteId });
      }
    }

    if (!customer) {
      const crn = await generateCRN();
      customer = await Customer.create({
        crn,
        name:        visitor.name || "Anonymous Visitor",
        email:       resolvedEmail,
        phone:       visitor.phone || null,
        websiteId:   visitor.websiteId,
        lastInteraction: visitor.updatedAt || new Date()
      });
      console.log(`  ➕ Created CRN ${crn} for visitor ${visitor.visitorId} (${visitor.name || "anon"})`);
      created++;

      // Try incrementing analytics customer count
      await Analytics.findOneAndUpdate(
        { websiteId: visitor.websiteId },
        { $inc: { "totals.customers": 1 } }
      );
    } else {
      console.log(`  🔗 Linked existing CRN ${customer.crn} to visitor ${visitor.visitorId}`);
      linked++;
    }

    // Update the visitor record
    visitor.customerId = customer._id;
    visitor.crn        = customer.crn;
    await visitor.save();
  }

  console.log("\n🎉 Backfill complete!");
  console.log(`   Created: ${created}`);
  console.log(`   Linked:  ${linked}`);
  console.log(`   Skipped: ${skipped}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error("❌ Backfill failed:", err.message);
  process.exit(1);
});
