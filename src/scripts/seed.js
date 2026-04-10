import bcrypt from "bcryptjs";
import { connectDatabase } from "../config/database.js";
import { User } from "../models/User.js";

async function seed() {
  await connectDatabase();

  let admin = await User.findOne({ email: "jtsadmin@gmail.com" });
  if (!admin) {
    admin = await User.create({
      name: "Admin",
      email: "jtsadmin@gmail.com",
      password: await bcrypt.hash("jts@123", 10),
      role: "admin"
    });
  } else {
    admin.password = await bcrypt.hash("jts@123", 10);
    admin.role = "admin";
    await admin.save();
  }

  let client = await User.findOne({ email: "client@gmail.com" });
  if (!client) {
    client = await User.create({
      name: "Client",
      email: "client@gmail.com",
      password: await bcrypt.hash("123456", 10),
      role: "client"
    });
  } else {
    client.password = await bcrypt.hash("123456", 10);
    client.role = "client";
    await client.save();
  }

  let agent = await User.findOne({ email: "agent@gmail.com" });
  if (!agent) {
    agent = await User.create({
      name: "Agent",
      email: "agent@gmail.com",
      password: await bcrypt.hash("123456", 10),
      role: "agent",
      managerId: client._id
    });
  } else {
    agent.password = await bcrypt.hash("123456", 10);
    agent.role = "agent";
    agent.managerId = client._id;
    await agent.save();
  }

  console.log("Seed complete");
  process.exit(0);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
