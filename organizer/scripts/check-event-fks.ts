import fs from "node:fs";
const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
async function main() {
  const { getPool } = await import("../src/lib/db/pool");
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      tc.table_name, tc.constraint_name,
      kcu.column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'events'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name`);
  console.log("--- events.id 참조하는 FK ---");
  console.table(rows);
  await pool.end();
}
void main();
