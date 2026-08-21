/**
 * 글로벌 테스트 정리 — E2E 테스트가 생성한 데이터를 삭제
 *
 * 식별 기준:
 *  - 이메일: buyer@test.kr, promo@test.kr
 *  - 상품 이름: "E2E " 접두사
 *  - 웹훅 이름: "E2E " 접두사
 *  - 프로모코드: PCT/FIX/AFF 접두사 (6자리 타임스탬프 접미사)
 */
import pg from "pg";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 🔴 컷오버로 **사라진 테이블**을 지우려다 청소가 통째로 멈추던 것 (2026-08-02).
 *
 * E2E 를 prod 와 같은 모양의 DB(`pickket_go_e2e`)로 돌리기 시작하면서 드러났다.
 * 이 파일이 건드리는 12개 중 **6개가 이미 없다**(v2 로 이관·DROP):
 *
 *     affiliates · message_templates · notifications
 *     promo_codes · registration_questions · schedule_items
 *
 * 첫 번째에서 던지면 뒤 청소가 전부 안 돈다 — 실제로 `promo_codes` 에서 멈췄다.
 *
 * ⚠️ **`.catch(() => {})` 로 덮지 않는다.** 그러면 "테이블이 없다" 와 "SQL 이 틀렸다" 가
 *    똑같이 조용해진다. 이 파일에 이미 그렇게 처리된 자리가 둘 있었고, 그래서
 *    나머지 4개가 문제라는 걸 아무도 몰랐다.
 *    ⟹ **테이블 존재를 먼저 확인**하고, 있는데 실패하면 **그대로 던진다.**
 */
async function deleteIfTableExists(
  pool: pg.Pool,
  table: string,
  whereSql: string,
  params: unknown[] = [],
): Promise<void> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`],
  );
  if (!rows[0]?.exists) return; // 컷오버로 사라진 테이블 — 청소할 것이 없다
  await pool.query(`DELETE FROM ${table} WHERE ${whereSql}`, params);
}

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function globalTeardown() {
  if (process.env.SKIP_TEST_CLEANUP === "1") return;

  loadEnv();

  const port = Number(process.env.PG_PORT ?? "5432");
  const pool = new pg.Pool({
    host: process.env.PG_HOST ?? "localhost",
    port: Number.isNaN(port) ? 5432 : port,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  try {
    // 테스트 이메일 또는 테스트 상품으로 생성된 주문 ID 수집
    const orderIds = await pool.query(
      `SELECT DISTINCT orders.id
       FROM orders
       LEFT JOIN order_items ON order_items.order_id = orders.id
       LEFT JOIN products ON products.id = order_items.product_id
       WHERE orders.buyer_email IN ('buyer@test.kr', 'promo@test.kr', 'dupe-complete@test.kr')
          OR orders.buyer_email LIKE 'race%@test.kr'
          OR orders.buyer_email LIKE 'over@test.kr'
          OR orders.buyer_email LIKE 'ghost@test.kr'
          OR products.name LIKE 'E2E %'
          OR products.name = '프로모 테스트 입장권'`,
    );
    const ids = orderIds.rows.map((r: { id: string }) => r.id);

    if (ids.length > 0) {
      // 의존 순서대로 삭제: 참석자 → 주문 아이템 → 주문
      // W5-ATTENDEE: `check_in_logs` 는 v2 정본으로 이관됐다(go mig252 DROP) → go 정리 대상 아님.
      //   v2 로그는 이벤트 CASCADE 로 정리되고, 남더라도 (ticket_id, 입장일) 유니크라 누적되지 않는다.
      await pool.query(`DELETE FROM attendees WHERE order_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM order_items WHERE order_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM orders WHERE id = ANY($1)`, [ids]);
    }

    // E2E 테스트 상품 삭제
    await pool.query(`DELETE FROM products WHERE name LIKE 'E2E %'`);
    // 프로모 테스트 상품 삭제
    await pool.query(`DELETE FROM products WHERE name = '프로모 테스트 입장권'`);

    // 웹훅 삭제
    await pool.query(`DELETE FROM webhooks WHERE name LIKE 'E2E %'`);

    // 프로모코드 — 정본은 v2 `discount_codes` 로 이관됐다(go 테이블 DROP).
    await deleteIfTableExists(pool, "promo_codes", `code ~ '^(PCT|FIX)[0-9]{6}$'`);

    // 어필리에이트
    await deleteIfTableExists(pool, "affiliates", `code ~ '^AFF[0-9]{6}$'`);

    // 체크인 리스트: W5-ATTENDEE 로 v2 정본 이관(go mig252 DROP) → go 정리 대상 아님.

    // 스케줄 삭제 (E2E 테스트 스케줄) — 테이블이 없을 수 있음
    await deleteIfTableExists(pool, "schedule_items", `description = 'E2E 테스트 스케줄'`);

    // 등록 질문 삭제
    await deleteIfTableExists(pool, "registration_questions", `label = '식이 제한이 있으신가요?'`);

    // 메시지 템플릿 삭제
    await deleteIfTableExists(pool, "message_templates", `title = '환영 메시지' AND body LIKE '%이벤트 참가가 확정%'`);

    // 복제된 이벤트 삭제 (title에 "(복사)" 포함)
    await pool.query(`DELETE FROM events WHERE title LIKE '%(복사)%'`);

    // 알림 삭제 (테스트 주문 관련)
    await deleteIfTableExists(pool, "notifications", `type = 'new_order' AND created_at > NOW() - INTERVAL '10 minutes'`);

    console.log(`[teardown] E2E 테스트 데이터 정리 완료 (주문 ${ids.length}건 삭제)`);
  } catch (err: unknown) {
    // teardown 실패는 테스트 결과에 영향 없음
    console.warn("[teardown] 정리 중 오류:", err instanceof Error ? err.message : err);
  } finally {
    await pool.end();
  }
}

export default globalTeardown;
