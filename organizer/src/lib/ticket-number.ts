import crypto from "node:crypto";

export function generateTicketNumber() {
  return `TKT-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}
