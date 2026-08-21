/**
 * E2E 픽스처 — 시드된 go 이벤트를 v2 에 write-through 생성하고 v2_event_id 를 연계한다.
 *
 * 배경: seed.ts 는 go events 를 직접 INSERT 하지만 v2_event_id 를 채우지 않는다.
 *   그런데 createOrder/상품 write-through 는 events.v2_event_id 를 필수로 요구하므로
 *   (DOMAIN_MODEL_STANDARD §주문=v2 SoT), 통합 e2e(order→ticket→checkin) 가 실패한다.
 *   test-prepare 가 provision-v2-test-accounts 직후 이 스크립트를 호출해 자동 연계한다.
 *
 * 동작:
 *   1) go DB(PG_*): 이벤트를 소유한 테스트 account 와 그 owner 의 v2_user_id 를 조회.
 *   2) v2 DB(V2_TEST_DATABASE_URL, 테스트 전용): 해당 owner(user_id) 의 organizer_profile
 *      go_account_id 를 시드 account 로 재링크. (이전 시드의 stale 프로필이 동일 slug 를
 *      점유해 provision-v2-test-accounts 의 import 가 409 로 스킵되는 문제를 테스트 DB
 *      위생 차원에서 보정 — prod 가드(409)는 건드리지 않음.)
 *   3) v2 API(createEvent): v2_event_id 가 없는 go 이벤트를 v2 에 멱등 생성하고 연계.
 *
 * V2_TEST_DATABASE_URL 미설정 시 2)를 스킵(이미 프로필이 정합이면 3)만으로 충분).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

// .env.local 로딩 (Next 외부 실행)
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

const TEST_ACCOUNT_EMAILS = ["demo@pickket.kr", "organizer@pickket.kr", "admin@pickket.kr"];

async function main() {
  const { getPool } = await import("@/lib/db/pool");
  const { createEvent, goAccountRef } = await import("@/lib/v2/commerce-client");
  const { toV2Category } = await import("@/lib/domain-model");
  const pool = getPool();

  // ── 1) 이벤트 소유 account + owner v2_user_id ──
  const owners = await pool.query<{ account_id: string; v2_user_id: string | null }>(
    `SELECT DISTINCT account_id, v2_user_id FROM users
       WHERE email = ANY($1) AND account_id IS NOT NULL`,
    [TEST_ACCOUNT_EMAILS],
  );

  // ── 2) v2 organizer_profile.go_account_id 재링크 (테스트 DB 위생) ──
  const v2Url = process.env.V2_TEST_DATABASE_URL;
  if (v2Url) {
    const v2 = new Client({ connectionString: v2Url });
    await v2.connect();
    try {
      for (const { account_id, v2_user_id } of owners.rows) {
        if (!v2_user_id) continue;
        const r = await v2.query(
          `UPDATE organizer_profiles SET go_account_id = $1 WHERE user_id = $2`,
          [account_id, v2_user_id],
        );
        if (r.rowCount) console.log(`[provision-events] v2 profile 재링크: user ${v2_user_id} → go_account ${account_id}`);
      }
    } finally {
      await v2.end();
    }
  } else {
    console.log("[provision-events] V2_TEST_DATABASE_URL 미설정 — 프로필 재링크 스킵(기존 정합 가정)");
  }

  // ── 3) 미연계 go 이벤트를 v2 write-through ──
  const { rows } = await pool.query<{
    id: string; account_id: string; title: string; event_type: string; starts_at: string;
  }>(
    `SELECT id, account_id, title, event_type, starts_at
       FROM events WHERE v2_event_id IS NULL ORDER BY created_at`,
  );
  console.log(`[provision-events] 연계 대상 ${rows.length}건`);
  let ok = 0;
  for (const ev of rows) {
    try {
      // 시드 이벤트 starts_at 이 (고정 과거 날짜라) opens_at(now) 이전이면 v2 sale_window
      // 검증(closes_at > opens_at)에 걸린다. 판매창을 미래로 보정(테스트 오픈 상태 보장).
      const opensAt = new Date();
      const startsAtMs = new Date(ev.starts_at).getTime();
      const closesAtMs = Math.max(startsAtMs, opensAt.getTime() + 30 * 86_400_000);
      const startsAtIso = new Date(Math.max(startsAtMs, closesAtMs)).toISOString();
      const result = await createEvent(
        {
          organizer_ref: goAccountRef(ev.account_id),
          external_ref: ev.id,
          title: ev.title,
          category: toV2Category(ev.event_type),
          event_date: startsAtIso,
          sale_window: { opens_at: opensAt.toISOString(), closes_at: new Date(closesAtMs).toISOString() },
          sale_channels: ["online"],
          status: "approved",
        },
        { idempotencyKey: `provision-${ev.id}` },
      );
      await pool.query(`UPDATE events SET v2_event_id = $1, updated_at = NOW() WHERE id = $2`, [result.event_id, ev.id]);
      ok++;
    } catch (err) {
      console.warn(`[provision-events] ${ev.title} 연계 실패: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
  console.log(`[provision-events] 완료 — ${ok}/${rows.length} v2 연계`);
  await pool.end();
}

main().catch((e) => {
  console.error("[provision-events] 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
