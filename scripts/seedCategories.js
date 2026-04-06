import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  subcategories: [String],
  websiteId: { type: mongoose.Schema.Types.ObjectId, required: true },
  managerId: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { timestamps: true });

const websiteSchema = new mongoose.Schema({
  managerId: { type: mongoose.Schema.Types.ObjectId, required: true }
});

const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);
const Website = mongoose.models.Website || mongoose.model('Website', websiteSchema);

const seedData = [
  { name: "Technical Support", subs: ["Bug Report", "API Integration", "Login Issue", "Slow Performance"] },
  { name: "Billing & Payments", subs: ["Invoice Request", "Refund Query", "Payment Failure", "Subscription Change"] },
  { name: "Account Management", subs: ["Password Reset", "Profile Update", "Account Deletion", "Multi-Factor Auth"] },
  { name: "Feature Requests", subs: ["New Icon Suggestion", "Mobile Optimization", "Workflow Automation", "Export Data"] },
  { name: "Product Inquiry", subs: ["Pricing Details", "Enterprise Solutions", "Feature Comparison", "Demo Request"] },
  { name: "Sales & Partnerships", subs: ["Affiliate Program", "Bulk Licensing", "Reseller Query", "Strategic Alliance"] },
  { name: "Security & Privacy", subs: ["Vulnerability Report", "Data Privacy Request", "Compliance Query", "Access Logs"] },
  { name: "Onboarding & Training", subs: ["Getting Started", "Webinar Request", "Documentation Help", "Best Practices"] },
  { name: "General Inquiry", subs: ["Office Location", "Career Opportunities", "Media Relations", "Feedback"] },
  { name: "Emergency Ops", subs: ["System Outage", "Data Breach Alert", "Critical Failure", "Legal Notice"] }
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB for seeding...");

    const website = await Website.findOne();
    if (!website) {
      console.error("No website found in database to associate categories with.");
      process.exit(1);
    }

    console.log(`Seeding categories for Website ID: ${website._id} and Manager ID: ${website.managerId}`);

    // Clean existing for this website (optional, keeping it for a clean start)
    // await Category.deleteMany({ websiteId: website._id });

    for (const item of seedData) {
      const exists = await Category.findOne({ name: item.name, websiteId: website._id });
      if (exists) {
        exists.subcategories = item.subs;
        await exists.save();
        console.log(`Updated: ${item.name}`);
      } else {
        await Category.create({
          name: item.name,
          subcategories: item.subs,
          websiteId: website._id,
          managerId: website.managerId
        });
        console.log(`Created: ${item.name}`);
      }
    }

    console.log("Seeding complete! 🚀");
    process.exit(0);
  } catch (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  }
}

seed();
