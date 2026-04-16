import { logger } from "../utils/logger.js";
import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDatabase() {
  await mongoose.connect(env.mongoUri);
  logger.log("MongoDB connected");
}
