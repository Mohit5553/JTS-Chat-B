import bcrypt from "bcryptjs";
import { connectDatabase } from "../config/database.js";
import { User } from "../models/User.js";

async function seed() {
  await connectDatabase();

  let admin = await User.findOne({ email: "admin@example.com" });
  if (!admin) {
    admin = await User.create({
      name: "Default Admin",
      email: "admin@example.com",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin"
    });
  }

  let client = await User.findOne({ email: "client@example.com" });
  if (!client) {
    client = await User.create({
      name: "Default Client",
      email: "client@example.com",
      password: await bcrypt.hash("Password123!", 10),
      role: "client"
    });
  }

  let agent = await User.findOne({ email: "agent@example.com" });
  if (!agent) {
    agent = await User.create({
      name: "Default Agent",
      email: "agent@example.com",
      password: await bcrypt.hash("Password123!", 10),
      role: "agent",
      managerId: client._id
    });
  }

  console.log("Seed complete");
  process.exit(0);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
