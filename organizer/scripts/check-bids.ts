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
    `SELECT b.id, b.user_id, b.quantity, b.status, b.waitlist_rank, b.desired_tier_id,
            b.created_at, als.event_id, e.title
     FROM bids b
     JOIN allocation_sessions als ON als.id = b.session_id
     JOIN events e ON e.id = als.event_id
     ORDER BY b.created_at DESC
     LIMIT 20`,
  );
  console.log("--- 최근 bids ---");
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
}

void main();
