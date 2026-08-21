import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const pool = getPool();
  const eventId = "ea20b11a-b1d6-487f-b848-994e0d5a7317";

  // seat_maps 컬럼 탐색
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'seat_maps' ORDER BY ordinal_position`,
  );
  console.log("--- seat_maps columns ---");
  console.log(cols.map((c) => c.column_name).join(", "));

  const { rows: maps } = await pool.query(
    `SELECT id, name, status FROM seat_maps WHERE event_id = $1`,
    [eventId],
  );
  console.log("\n--- seat_maps rows ---");
  console.log(maps);

  // seats.tier_id 분포 + 샘플
  const { rows: distr } = await pool.query(
    `SELECT s.tier_id, t.name AS tier_name, COUNT(*)::int AS count
     FROM seats s
     LEFT JOIN seat_tiers t ON t.id = s.tier_id
     JOIN seat_maps sm ON sm.id = s.seat_map_id
     WHERE sm.event_id = $1
     GROUP BY s.tier_id, t.name`,
    [eventId],
  );
  console.log("\n--- seats by tier_id ---");
  console.log(distr);

  // section 정보 (seats.section 컬럼)
  const { rows: sec } = await pool.query(
    `SELECT section, tier_id, COUNT(*)::int
     FROM seats s JOIN seat_maps sm ON sm.id = s.seat_map_id
     WHERE sm.event_id = $1 GROUP BY section, tier_id ORDER BY section`,
    [eventId],
  );
  console.log("\n--- seats by section ---");
  console.log(sec);

  await pool.end();
}

void main();
