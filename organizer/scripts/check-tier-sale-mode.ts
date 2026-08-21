import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, sale_mode, capacity FROM seat_tiers WHERE event_id = 'ea20b11a-b1d6-487f-b848-994e0d5a7317'`,
  );
  console.log(rows);
  await pool.end();
}
void main();
