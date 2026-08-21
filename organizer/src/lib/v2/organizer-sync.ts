/**
 * GO → v2 organizer/team 자동 동기화.
 *
 * 5/7 cutover 후 — 신규 organizer profile / team member 가 만들어질 때마다
 * v2 의 import endpoint 로 미러. 실패해도 go 응답에 영향 없음 (fire-and-forget + 로그).
 *
 * v2 측은 go_account_id / go_event_organizer_id 기준 idempotent upsert 처리.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { getPool } from "@/lib/db/pool";

// V2_BASE 는 **호출 시점 lazy** — 모듈 로드 시점 캡처 금지(cron/스크립트의 ESM import 가
// .env.local 로더보다 먼저 실행되면 staging 기본값으로 굳어 서명거부됨. commerce-client 와 동일 교훈).
function getV2Base(): string {
  return process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";
}
const PROFILE_PATH = "/api/v1/internal/organizer/profiles/import";

function sign(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function callV2(path: string, payload: unknown, event: string): Promise<unknown | null> {
  // 🔴 `GO_WEBHOOK_SECRET` 우선 · `V2_EVENT_SYNC_SECRET` 폴백 — 이 리포의 계약이다
  //    (messaging-ledger-client.ts:46 등 동작 중인 클라이언트 전부 같은 형태).
  //    v2 `internal_sync` 는 전 라우트를 `settings.GO_WEBHOOK_SECRET` 로 검증한다.
  //    종전엔 `V2_EVENT_SYNC_SECRET` 단독이라, 그 값만 없으면 **조용히 스킵**됐다.
  const secret = process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
  if (!secret) {
    logger.debug("v2 organizer sync 스킵: GO_WEBHOOK_SECRET/V2_EVENT_SYNC_SECRET 미설정");
    return null;
  }

  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = sign(secret, timestamp, body);

  try {
    const res = await fetch(`${getV2Base()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": event,
        "X-Pickket-Delivery-Id": crypto.randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn("v2 organizer sync 실패", { event, status: res.status, body: text.slice(0, 200) });
      return null;
    }

    return await res.json();
  } catch (err) {
    logger.warn("v2 organizer sync 에러", {
      event,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

/**
 * accountId 의 사업자 프로필 + owner user 정보를 v2 organizer_profiles 로 미러.
 * 응답으로 받은 v2_organizer_profile_id 를 accounts 에 backfill.
 *
 * 🔴 W2-EVT 잔여(범위 밖 의존): 이 함수만 go `accounts`/`users` 를 읽는다. 계정·사용자 테이블
 *    이관은 별도 트랙 소관이라 여기서는 건드리지 않는다. 앱 라우트 호출부는 0건이고
 *    `scripts/provision-v2-test-accounts.ts`(테스트 계정 프로비저닝)만 사용한다.
 */
export async function pushOrganizerProfileToV2(accountId: string): Promise<string | null> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    name: string;
    slug: string;
    business_number: string | null;
    contact_email: string;
    contact_phone: string | null;
    trust_tier: string;
    trust_score: number;
    owner_v2_user_id: string | null;
    owner_name: string | null;
  }>(
    `SELECT a.id, a.name, a.slug, a.business_number, a.contact_email, a.contact_phone,
            a.trust_tier, a.trust_score,
            u.v2_user_id AS owner_v2_user_id,
            u.name AS owner_name
     FROM accounts a
     LEFT JOIN users u ON u.id = a.owner_user_id
     WHERE a.id = $1
     LIMIT 1`,
    [accountId],
  );

  const acc = rows[0];
  if (!acc) {
    logger.warn("v2 profile sync 스킵: account 없음", { accountId });
    return null;
  }
  if (!acc.owner_v2_user_id) {
    logger.warn("v2 profile sync 스킵: owner v2_user_id 누락", { accountId });
    return null;
  }

  const result = (await callV2(
    PROFILE_PATH,
    {
      go_account_id: acc.id,
      owner_v2_user_id: acc.owner_v2_user_id,
      name: acc.name,
      slug: acc.slug,
      business_number: acc.business_number,
      representative_name: acc.owner_name ?? acc.name,
      contact_email: acc.contact_email,
      contact_phone: acc.contact_phone,
      trust_tier: acc.trust_tier ?? "new",
      trust_score: acc.trust_score ?? 0,
    },
    "organizer.profile.import",
  )) as { v2_organizer_profile_id?: string } | null;

  if (!result?.v2_organizer_profile_id) return null;

  await pool
    .query(`UPDATE accounts SET v2_organizer_profile_id = $1 WHERE id = $2`, [
      result.v2_organizer_profile_id,
      accountId,
    ])
    .catch(() => {});

  return result.v2_organizer_profile_id;
}

/**
 * @deprecated 레벨2 컷오버 W2-EVT 에서 **무력화됨**(항상 `null` 반환).
 *
 * 옛 동작: go `event_organizers` 행 1개를 v2 `organizer_team_members`(event-level 미러)로 push.
 *
 * ## 왜 no-op 인가
 * W2-EVT 가 go `organizers`/`event_organizers` 를 v2 `event_hosts`/`event_host_links` 로
 * 이관하면서 이 함수의 **소스 테이블이 사라졌다**. 원 쿼리는
 * `event_organizers JOIN events JOIN accounts JOIN organizers` 였다.
 *
 * event-level 미러가 무엇을 위해 존재했는지 실측했다:
 *  - v2 `tickets.py` 의 권한 판정은 `OrganizerTeamMember.organizer_id == event.organizer_id`
 *    (org-level)만 보고 `event_id` 로 좁히지 않는다 → event-level 행은 권한에 무관.
 *  - go 측 read 는 0건(주최자 표기는 이제 `event_host_links` 가 소유).
 * → 이 push 를 멈춰도 권한·표기 어디에도 영향이 없다.
 *
 * 시그니처는 유지한다 — `scripts/backfill-v2-gap-fields.ts`(범위 밖)가 아직 import 한다.
 * ⚠️ 후속 정리: 그 스크립트와 `src/app/api/invitations/accept/route.ts` 의 죽은 import 제거.
 *   (org-level 팀 멤버십은 invitations/accept 가 별도 직접 호출로 계속 처리한다 — 무관.)
 */
export async function pushTeamMemberToV2(eventOrganizerId: string): Promise<string | null> {
  logger.debug("pushTeamMemberToV2 no-op (W2-EVT: event_organizers 폐지)", { eventOrganizerId });
  return null;
}
