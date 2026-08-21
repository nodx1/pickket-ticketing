import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const pool = getPool();
  // 받은 webhook 로그 (outbound 전용이면 필요 없음)
  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%webhook%'`,
  );
  console.log("--- webhook tables ---");
  console.log(tables);

  // event_reviews 로 승인 이벤트 체크
  const { rows: reviews } = await pool.query(
    `SELECT event_id, action, reason, created_at FROM event_reviews WHERE event_id = '0b04c524-4145-4df0-8e4a-0d10008b7bd0' ORDER BY created_at DESC`,
  );
  console.log("--- 이벤트3 review history ---");
  console.log(JSON.stringify(reviews, null, 2));

  await pool.end();
}

void main();
