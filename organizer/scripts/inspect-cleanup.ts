/**
 * 삭제 전 현황 조회 — accounts / organizers / events 목록.
 */
import fs from "node:fs";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const { getPool } = await import("../src/lib/db/pool");
  const pool = getPool();

  console.log("=== accounts ===");
  const { rows: accounts } = await pool.query(
    `SELECT id, name, trust_tier, created_at FROM accounts ORDER BY created_at`,
  );
  console.log(accounts);

  console.log("\n=== organizers ===");
  const { rows: organizers } = await pool.query(
    `SELECT o.id, o.name, o.account_id, a.name AS account_name
     FROM organizers o JOIN accounts a ON a.id = o.account_id
     ORDER BY o.created_at`,
  );
  console.log(organizers);

  console.log("\n=== events ===");
  const { rows: events } = await pool.query(
    `SELECT e.id, e.title, e.status, o.name AS organizer_name, a.name AS account_name, e.created_at
     FROM events e
     JOIN organizers o ON o.id = e.organizer_id
     JOIN accounts a ON a.id = e.account_id
     ORDER BY e.created_at DESC`,
  );
  console.log(events);

  console.log(`\n총 accounts=${accounts.length}, organizers=${organizers.length}, events=${events.length}`);

  await pool.end();
}
void main();
