/**
 * 임시 복구 스크립트 — v2 webhook 누락으로 싱크 깨진 이벤트를 수동 승인 처리.
 *
 * 이벤트3 (0b04c524-4145-4df0-8e4a-0d10008b7bd0) 가 v2 에선 live 로 승인됐지만
 * v2 admin UI 의 webhook 호출 누락으로 go 에는 pending_review 로 남은 상태.
 *
 * webhook 이 수행했어야 할 작업을 수동 재현:
 *   1. events.status = 'live'
 *   2. event_reviews INSERT (approve)
 *   3. accounts.trust_score + 10 (승격 임계 50/100)
 */
import { getPool } from "../src/lib/db/pool";
import fs from "node:fs";

const env = fs.readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const EVENT_ID = "0b04c524-4145-4df0-8e4a-0d10008b7bd0";

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{
      status: string;
      account_id: string;
      title: string;
    }>(`SELECT status, account_id, title FROM events WHERE id = $1`, [EVENT_ID]);
    if (rows.length === 0) throw new Error("event not found");
    console.log("현재 상태:", rows[0]);

    if (rows[0].status !== "pending_review") {
      console.log("이미 pending_review 가 아님 — 스킵");
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE events SET status = 'live', updated_at = NOW() WHERE id = $1`,
      [EVENT_ID],
    );

    await client.query(
      `INSERT INTO event_reviews (event_id, action, reason, checklist, reviewer_user_id)
       VALUES ($1, 'approve', $2, $3::jsonb, NULL)`,
      [
        EVENT_ID,
        "v2 admin 승인됐으나 webhook 누락 — go 수동 동기화",
        JSON.stringify({ source: "manual-sync", synced_at: new Date().toISOString() }),
      ],
    );

    await client.query(
      `UPDATE accounts
       SET trust_score = trust_score + 10,
           trust_tier = CASE
             WHEN trust_score + 10 >= 100 THEN 'premium'
             WHEN trust_score + 10 >= 50 THEN 'verified'
             ELSE trust_tier
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [rows[0].account_id],
    );

    await client.query("COMMIT");
    console.log("✅ 수동 승인 동기화 완료:", rows[0].title);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
