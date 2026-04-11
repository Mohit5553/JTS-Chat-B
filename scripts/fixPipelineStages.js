import mongoose from "mongoose";
import { Customer } from "../src/models/Customer.js";

const VALID_STAGES = ["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"];

const LEGACY_MAP = {
  proposition: "proposal_sent",
  hold: "contacted",
  opportunity: "qualified",
  prospect: "new",
  lead: "new",
  customer: "won",
  inactive: "lost",
  in_progress: "contacted",
  pending: "contacted",
  active: "new"
};

(async () => {
  await mongoose.connect("mongodb+srv://chatAI:bawsfL1sbUHjKTVt@cluster0.ehduwnn.mongodb.net/chat-support?retryWrites=true&w=majority");
  console.log("Connected. Scanning for invalid pipelineStage values...\n");

  const allStages = await Customer.distinct("pipelineStage");
  console.log("All distinct pipelineStage values:", allStages);

  const invalid = allStages.filter((s) => !VALID_STAGES.includes(s));

  if (invalid.length === 0) {
    console.log("\nNo invalid stages found. DB is clean!");
  } else {
    console.log("\nInvalid stages found:", invalid);
    for (const stage of invalid) {
      const target = LEGACY_MAP[stage] || "new";
      const res = await Customer.updateMany({ pipelineStage: stage }, { pipelineStage: target });
      console.log(`  "${stage}" -> "${target}": ${res.modifiedCount} record(s) fixed`);
    }
    console.log("\nMigration complete.");
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
