import crypto from "crypto";

export function generateApiKey() {
  return crypto.randomBytes(16).toString("hex");
}

export function generatePublicId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
