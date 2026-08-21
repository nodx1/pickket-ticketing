import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, title, status, updated_at FROM events WHERE title LIKE '%테스트%' OR title LIKE '%피켓%' ORDER BY updated_at DESC LIMIT 10`,
  );
  console.log("--- events ---");
  console.log(JSON.stringify(rows, null, 2));
  const { rows: reviews } = await pool.query(
    `SELECT event_id, action, reason, created_at FROM event_reviews ORDER BY created_at DESC LIMIT 10`,
  );
  console.log("--- reviews ---");
  console.log(JSON.stringify(reviews, null, 2));
  await pool.end();
}

void main();
