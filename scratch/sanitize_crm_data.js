import mongoose from "mongoose";
import dotenv from "dotenv";
import { Customer } from "../src/models/Customer.js";

dotenv.config({ path: "./.env" });

async function sanitize() {
  try {
    console.log("Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Successfully connected to database.");

    const fieldsToClean = ["companyName", "pipelineStage", "leadStatus", "dealStage", "name", "email", "phone", "requirement", "timeline", "leadSource"];
    const stringsToMatch = ["undefined", "null", "none", "nan"];

    let totalFixed = 0;

    for (const field of fieldsToClean) {
      console.log(`Checking field: ${field}...`);
      
      // Case-insensitive regex to catch "undefined", "Null", etc.
      const regex = new RegExp(`^(${stringsToMatch.join("|")})$`, "i");
      
      const query = { [field]: { $regex: regex } };
      const records = await Customer.find(query);
      
      if (records.length > 0) {
        console.log(`Found ${records.length} records with invalid string literal in '${field}'`);
        
        for (const doc of records) {
          // Setting to empty string or appropriate default
          doc[field] = "";
          await doc.save();
          totalFixed++;
        }
      }
    }

    console.log(`\nSanitization complete! Total fields corrected: ${totalFixed}`);
    process.exit(0);
  } catch (error) {
    console.error("Sanitization failed:", error);
    process.exit(1);
  }
}

sanitize();
