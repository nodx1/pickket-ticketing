import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { getPool } from "@/lib/db/pool";

// .env.local 자동 로딩 (Next.js 외부 실행 시 — migrate.ts 와 동일 패턴).
// 없으면 수동 `npx tsx scripts/seed.ts` 가 PG_PORT 미설정 → 5432 기본값 → ECONNREFUSED.
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  for (const line of fs.readFileSync(envLocalPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  const pool = getPool();
  // BFF cutover 후 password_hash 는 인증에 안 쓰임(v2 가 검증). seed 호환성 위해서만 set.
  // 비번값은 v2 정책 준수 + provision-v2-test-accounts.ts·helpers/auth.ts 와 동일하게 유지.
  const passwordHash = await bcrypt.hash("Test1234!", 12);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accountResult = await client.query<{ id: string }>(
      `
        INSERT INTO accounts (
          id, name, slug, business_number, contact_email, contact_phone, owner_user_id,
          currency, timezone, is_active, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(), '픽켓 데모', 'pickket-demo', NULL, 'demo@pickket.kr', '010-1234-5678', NULL,
          'KRW', 'Asia/Seoul', true, NOW(), NOW()
        )
        ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `,
    );

    const accountId = accountResult.rows[0]?.id;

    const userResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (
          id, account_id, email, name, role, phone, password_hash, is_active, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(), $1, 'demo@pickket.kr', '픽켓 관리자', 'owner', '010-1234-5678', $2, true, NOW(), NOW()
        )
        ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
        RETURNING id
      `,
      [accountId, passwordHash],
    );

    const userId = userResult.rows[0]?.id;

    await client.query("UPDATE accounts SET owner_user_id = $2 WHERE id = $1", [accountId, userId]);

    // E2E 테스트용 admin 계정 (organizer@pickket.kr)
    await client.query(
      `
        INSERT INTO users (
          id, account_id, email, name, role, phone, password_hash, is_active, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(), $1, 'organizer@pickket.kr', '픽켓 운영자', 'admin', '010-9999-8888', $2, true, NOW(), NOW()
        )
        ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
      `,
      [accountId, passwordHash],
    );

    /**
     * 🔴 레벨2 컷오버(W2-EVT) 이후 `organizers` 테이블과 `events.organizer_id` 는 **DROP** 됐다.
     *    주최자 프로필의 SSOT 는 v2 `organizer_profiles` 다.
     *
     * 그런데 이 시드는 옛 스키마를 전제하고 있었다 — **깨끗한 DB 에서는 시드가 실패한다.**
     * 실측(2026-07-30): 새 DB 는 마이그 254개가 적용되는데 기존 dev DB(`pickket_go`)는
     * **176개**에서 멈춰 있다(컷오버 DROP 가드가 데이터 때문에 차단). 즉 지금까지의
     * E2E·스모크는 **트렁크 마이그레이션과 다른 스키마** 위에서 돌고 있었다.
     *
     * ⟹ 양쪽에서 다 돌게 **스키마를 보고 분기**한다. 옛 DB 를 쓰는 다른 세션이 깨지지 않아야 한다.
     */
    const legacy = await client.query<{ has_organizers: boolean; has_event_organizer_id: boolean }>(
      `
        SELECT
          EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'organizers') AS has_organizers,
          EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'events' AND column_name = 'organizer_id') AS has_event_organizer_id
      `,
    );
    const hasOrganizers = legacy.rows[0]?.has_organizers ?? false;
    const hasEventOrganizerId = legacy.rows[0]?.has_event_organizer_id ?? false;

    let organizerId: string | null = null;
    if (hasOrganizers) {
      const organizerResult = await client.query<{ id: string }>(
        `
          INSERT INTO organizers (
            id, account_id, name, slug, description, email, phone, is_published, created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), $1, '픽켓 스튜디오', 'pickket-studio', '샘플 주최자', 'organizer@pickket.kr', '010-5555-1111', true, NOW(), NOW()
          )
          ON CONFLICT (account_id, slug) DO UPDATE SET updated_at = NOW()
          RETURNING id
        `,
        [accountId],
      );
      organizerId = organizerResult.rows[0]?.id ?? null;
    }

    // `organizer_id` 는 컷오버 이후 없다 — 스키마에 있을 때만 넣는다(옛 DB 호환).
    const orgCol = hasEventOrganizerId ? "organizer_id," : "";
    const orgVal = hasEventOrganizerId ? "$2," : "";
    await client.query(
      `
        INSERT INTO events (
          id, account_id, ${orgCol} title, slug, summary, description, venue_name, venue_address,
          event_type, age_rating, max_attendees, is_online,
          starts_at, ends_at, timezone, status, created_at, updated_at
        )
        VALUES
          (
            gen_random_uuid(), $1, ${orgVal} '픽켓 데모 컨퍼런스', 'pickket-demo-conference',
            '첫 샘플 이벤트', '운영 테스트용 샘플 이벤트입니다.', '픽켓 홀', '서울 강남구',
            'conference', 'all', 250, false,
            NOW() + INTERVAL '14 days', NOW() + INTERVAL '14 days' + INTERVAL '5 hours', 'Asia/Seoul', 'draft', NOW(), NOW()
          ),
          (
            gen_random_uuid(), $1, ${orgVal} '픽켓 뮤직 나이트', 'pickket-music-night',
            '두 번째 샘플 이벤트', '티켓 판매 흐름 테스트용 이벤트입니다.', '픽켓 라이브룸', '서울 성수동',
            'concert', '15+', 500, false,
            NOW() + INTERVAL '30 days', NOW() + INTERVAL '30 days' + INTERVAL '3 hours', 'Asia/Seoul', 'live', NOW(), NOW()
          )
        ON CONFLICT (account_id, slug) DO UPDATE SET updated_at = NOW()
      `,
      hasEventOrganizerId ? [accountId, organizerId] : [accountId],
    );

    // ── 레벨2 컷오버 T2-PHASE ──
    // 판매 단계 시드는 제거됐다. go `sale_phases` 는 DROP 됐고 SSOT 는 v2 `phase_configs` 다.
    // 공정추첨 E2E 는 주최자 UI(판매 방식 저장) 또는 v2
    // `PUT /api/v1/internal/events/{id}/sale-plan` 으로 단계를 준비한다.

    await client.query("COMMIT");
    console.log("시드 데이터가 준비되었습니다.");
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(err.message);
  }
  process.exitCode = 1;
});
