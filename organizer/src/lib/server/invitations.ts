import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { stripAdmissionDay } from "@/lib/invitations/admission-policy";
import { createOrder, EventAccessError, V2CommerceError } from "@/lib/server/orders";
import { ensureCompProduct } from "@/lib/server/rsvp-product";
import {
  claimInvitationDispatch,
  completeInvitationDispatch,
  getEvent,
  listEventInvitations,
  listPendingDeliveryCheck,
  markInvitationByTicketNumber,
  markInvitationFailedV2,
  markInvitationIssued,
  reportInvitationDeliveryResult,
  requeueInvitationDispatch,
  resendInvitationV2,
  invitationNextSeq,
  reserveInvitation,
  revokeInvitationV2,
  v2ErrorCode,
} from "@/lib/v2/commerce-client";
import { getOwnedEvent } from "@/lib/v2/event-access";
import { getPrefixedRedis } from "@/lib/redis";
import { getPool } from "@/lib/db/pool";
import {
  BATCH_CLAIM_TTL_SECONDS,
  BATCH_RESULT_TTL_SECONDS,
  BATCH_STATE_PROCESSING,
  invitationBatchFingerprint,
  invitationBatchKey,
} from "@/lib/server/invitation-batch-key";
import { createInvitationToken, INVITE_TOKEN_PARAM } from "@/lib/invitation-token";
import { formatDateKst, formatWeekdayKst } from "@/lib/format";
import {
  ALIMTALK_TEMPLATES,
  hasAlimtalkCredentials,
  sendAlimtalkBatch,
  fetchAlimtalkDeliveryStatus,
  type AlimtalkButton,
  type AlimtalkFailover,
} from "@/lib/notification/alimtalk";

/**
 * F2 초대권 대량 배포 — 명단→comp 발권→알림톡 큐 적재→(cron) 배치 발송→추적.
 *
 * ── 레벨2 컷오버 W5-ATTENDEE ──
 * 원장(`event_invitations`)과 발송 큐(`invitation_dispatch`)가 **v2 정본**으로 이관됐다.
 * go DB SQL 0. 계약은 `platform/backend/app/api/v1/internal_attendee_ledger.py`.
 *
 * 설계 증명(발송 무결성 규약):
 *  - **멱등(수신자 단위)**: v2 UNIQUE(event_id, phone_normalized). 예약 API 가 `created` 를
 *    돌려주고, **`created=true` 인 경우에만** comp 발권(v2 주문 생성)을 한다. "동시 2회
 *    실행하면?" → 둘 중 하나만 created=true 를 받는다(다른 하나는 유니크 위반을 v2 가 잡아
 *    기존 행 재생) → 같은 번호에 초대권 2장은 구조적으로 불가.
 *  - **비동기**: bulk API 는 발권+큐적재까지만(동기 per-row NCP 왕복 없음). 실발송은 cron 이
 *    claim-lease 로 배치 처리 → cron 동시 2회에도 이중발송 없음.
 *  - **외부호출 후 crash 하면?**: 드레인이 NCP 발송 직후 죽으면 리스 만료 후 재클레임된다.
 *    이때 **멱등키가 같아야** 알림톡이 두 번 나가지 않는다. 그래서 멱등키를
 *    `sha256(정렬된 "dispatchId:sendEpoch" 목록)` 으로 **안정 파생**한다. `send_epoch` 는
 *    클레임으로 변하지 않고 주최자의 **명시적 재발송에서만** +1 되므로,
 *      · crash 재시도 → 같은 키 → NCP dedup → 1통
 *      · 명시적 재발송 → 다른 키 → 실제로 다시 발송
 *    이 둘이 분리된다. (옛 구현은 매 tick 랜덤 claim_token 을 멱등키로 써서 재시도가
 *     그대로 2통이 되는 구조였다.)
 */

const APP_ORIGIN = () => (process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://go.pickket.kr").replace(/\/$/, "");

// SMS/LMS 대체 발신번호(선택) — 설정 시 알림톡 실패 시 링크 포함 LMS 로 대체 발송한다.
const SMS_FROM = () => process.env.SENS_SMS_FROM?.trim() || undefined;

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export interface BulkRecipientInput {
  name: string;
  phone: string;
  /** F1 daypass 지정일(YYYY-MM-DD). 미지정이면 allpass/single/선택형 daypass. */
  admissionDay?: string | null;
  /** F1/F5 입장 규칙(single|daypass|allpass). 초대권 화면 "입장 가능 일자" 표기용 스냅샷. */
  admissionMode?: "single" | "daypass" | "allpass" | null;
}

export interface BulkIssueResult {
  requested: number;    // 입력 줄 수.
  issued: number;       // **발급된 초대권 장수**(사람 수가 아니다 — 1인 여러 장 가능).
  atLimit: number;      // 그 번호가 이미 상한(v2 가 판정)이라 발급하지 못한 줄 수.
  invalid: number;      // 전화번호가 없거나 형식이 잘못돼 발송 불가한 줄 수.
  failed: number;       // 예약·발권 실패 줄 수(v2 오류 등).
  capExceeded: boolean; // 행사 전체 comp 캡 초과로 일부/전부 차단됨.
  failures: Array<{ phone: string; reason: string }>;
  /** 같은 명단을 이미 처리했다 — 저장된 결과를 그대로 돌려준 것(추가 발급 없음). */
  replayed?: boolean;
  /** 같은 명단이 지금 처리 중이다(동시 클릭). 추가 발급 없음. */
  inProgress?: boolean;
  /**
   * 배치 지문(sha256 hex) — 발송 가능한 줄이 1개 이상이면 항상 채운다.
   *
   * 화면이 *"어느 명단이 막혔는지"* 를 보여주고 운영자가 런북으로 Redis 키를
   * 짚을 수 있게 하기 위한 값이다. 수신자는 이미 이 명단을 업로드한 주최자
   * 본인(`withRole("organizer")` + `requireFeature` 통과)이라 새로 알려주는
   * 정보가 없다 — 자기가 올린 명단의 해시일 뿐이다.
   *
   * ⚠️ 이 값을 **다시 받아서** 키를 조립하지 않는다. 그렇게 하면 클라이언트가
   *    임의 Redis 키를 지우게 된다(타 행사 멱등 해제). 해제는 `force` 불리언만
   *    받고 지문은 항상 서버가 명단에서 재계산한다.
   */
  batchFingerprint?: string;
}

/**
 * 🔴 `dedupeRecipients` 를 **제거했다**(2026-07-30, 1인 최대 5장 요건).
 *
 * 종전에는 phone 정규화 기준으로 배치 내 중복을 접어 v2 에 **한 건만** 보냈다.
 * 그래서 v2 가 `UNIQUE(event_id, phone_normalized, seq)` 로 다장 발급을 열어도
 * **go 가 먼저 접어 화면에서는 아무 변화가 없었다** — 이 변경의 실제 관문이 여기였다.
 *
 * 지금은 같은 번호를 여러 줄 넣으면 그만큼 발급한다. 상한은 **v2 가 409
 * `INVITATION_LIMIT`** 으로 알려주고, 그것이 루프의 단일 종료 조건이다.
 * ⚠️ 상한 숫자를 go 에 복제하지 않는다(호출자가 세면 동시 요청에 뚫린다).
 */

/**
 * 루프 폭주 방어용 상한 — **업무 규칙이 아니다.** 실제 종료는 v2 의 409 가 판정한다.
 *
 * 🔴 상한(v2 `INVITATION_MAX_PER_PHONE`)보다 **넉넉히 커야** 한다. 같은 값으로 두면
 *    다음에 v2 만 올렸을 때 go 가 **조용히 자른다** — 2026-08-09 이전이 정확히 그
 *    상태였다(v2 5 / go 20 이라 우연히 안 걸렸을 뿐, 50 으로 올리자 20에서 멎었다).
 * ⚠️ 그렇다고 상한 숫자를 여기 복제하지도 않는다(호출자가 세면 동시 요청에 뚫린다).
 *    이 값은 "이 정도면 코드 버그다" 의 경계일 뿐이다.
 */
const SEQ_LOOP_GUARD = 60;

/**
 * 발송 가능한 줄만 남긴다 — **중복은 접지 않는다**(위 주석 참조).
 * 전화번호가 없거나 숫자를 못 뽑는 줄은 `invalid` 로 집계해 제외한다.
 */
function normalizeRecipients(recipients: BulkRecipientInput[]): {
  sendable: Array<BulkRecipientInput & { phoneNormalized: string }>;
  invalid: number;
} {
  const sendable: Array<BulkRecipientInput & { phoneNormalized: string }> = [];
  let invalid = 0;
  for (const r of recipients) {
    const phoneNormalized = normalizePhone(r.phone);
    if (!phoneNormalized) {
      invalid += 1;
      continue;
    }
    sendable.push({ ...r, phoneNormalized });
  }
  return { sendable, invalid };
}

/**
 * 대량 초대권 발권 + 발송 큐 적재 — **배치 멱등** 래퍼.
 *
 * 🔴 왜 래퍼가 필요한가: phone 중복제거를 없앤 대가로 "같은 파일 두 번" 방어가 사라졌다.
 *    붙여넣기 실수는 한 사람이지만 파일 재업로드는 **명단 전체**이고, 알림톡은 회수할 수 없다.
 *    근거·키 설계는 `invitation-batch-key.ts` 상단 참조.
 *
 * 동시 클릭이 주 시나리오라 **사후 조회로는 못 막는다** — `SET NX` 로 먼저 선점한다.
 *
 * 🔴 Redis 장애 시 **거부한다**(fail-closed). 이 보호에는 2차 계층이 없고, 막으려는 사고가
 *    되돌릴 수 없는 발송이다. 웹훅 멱등(`webhook/idempotency.ts`)은 DB UNIQUE 가 받쳐주지만
 *    이쪽은 없다. 문의 폼의 `onRedisError: "closed"` 와 같은 정책이다.
 */
export async function bulkIssueInvitations(input: {
  accountId: string;
  eventId: string;
  recipients: BulkRecipientInput[];
  /**
   * 멱등 **명시 해제** — 저장된 배치 결과를 버리고 이 명단을 다시 발급한다.
   *
   * 🔴 왜 필요한가 (2026-07-31 실사고): 이 캐시는 Redis 에 7일 남는데 **지우는 코드가
   *    어디에도 없었다.** 테스트 데이터를 DB 에서 전부 지운 뒤 같은 명단을 다시 올리자
   *    *"이미 처리한 명단"* 만 나오고 손쓸 방법이 없었다. 대회 중에 이게 나면
   *    명단을 한 줄 바꿔 지문을 흐트러뜨리는 편법밖에 없고, 그건 실수를 유도한다.
   *
   * ⚠️ **자동 해제는 하지 않는다.** "원장이 비었으면 알아서 풀자" 가 위험한 이유는
   *    *원장 삭제가 발송 취소를 뜻하지 않기* 때문이다 — 행을 지워도 알림톡은 이미
   *    나갔고, 나갔다는 사실만 원장에서 사라진다. 그 상태에서 자동 재발급하면
   *    같은 사람에게 두 번 간다. 그래서 **사람이 명시적으로** 켜야 한다.
   *    (회수는 soft 라 행이 남으므로 "회수하면 원장이 빈다" 는 근거가 아니다.)
   */
  force?: boolean;
}): Promise<BulkIssueResult> {
  const { eventId } = input;

  // 🔴 초대권은 입장일을 지정하지 않는다(정책: @/lib/invitations/admission-policy).
  //    화면에서 입력을 없앴지만 **낡은 클라이언트·직접 API 호출**이 admissionDay 를
  //    보내면 그대로 박힌다. 여기가 최종 관문이다.
  const { recipients, stripped } = stripAdmissionDay(input.recipients);
  if (stripped > 0) {
    logger.warn("초대권 입장일이 요청에 포함돼 있어 제거했다(정책: 미지정)", {
      eventId,
      stripped,
    });
  }

  // 🔴 순서 — strip 이 normalize 보다 **먼저**다. 뒤집으면 정규화된 수신자에 날짜가
  //    남은 채로 예약 루프에 들어간다(둘은 독립이지만 이 순서만은 독립이 아니다).
  const { sendable, invalid } = normalizeRecipients(recipients);


  const empty = (over: Partial<BulkIssueResult> = {}): BulkIssueResult => ({
    requested: recipients.length,
    issued: 0,
    atLimit: 0,
    invalid,
    failed: 0,
    capExceeded: false,
    failures: [],
    ...over,
  });

  const fingerprint = invitationBatchFingerprint(eventId, sendable);
  if (!fingerprint) return empty(); // 발송 가능한 줄이 0 — 멱등 처리할 것이 없다.

  // 🔴 키는 **항상 서버가 조립한다** — eventId(경로 파라미터, 소유 검증됨) + 방금
  //    명단에서 재계산한 지문. 클라이언트가 준 문자열은 키에 한 조각도 들어가지 않는다.
  //    (들어가면 임의 Redis 키 삭제가 되어 타 행사의 멱등까지 풀 수 있다.)
  const key = invitationBatchKey(eventId, fingerprint);
  let redis: ReturnType<typeof getPrefixedRedis>;
  try {
    redis = getPrefixedRedis();

    // 명시 해제 — 선점 **전에** 지운다. 뒤에 지우면 아래 SET NX 가 먼저 막힌다.
    if (input.force) {
      const removed = await redis.del(key);
      logger.warn("🔴 초대권 배치 멱등을 명시 해제했다 — 같은 명단이 다시 발송된다", {
        eventId,
        accountId: input.accountId,
        fingerprint,
        removed, // 0 이면 애초에 막혀 있지 않았다(그래도 진행한다).
        recipients: sendable.length,
      });
    }

    const claimed = await redis.set(
      key,
      BATCH_STATE_PROCESSING,
      "EX",
      BATCH_CLAIM_TTL_SECONDS,
      "NX",
    );
    if (claimed !== "OK") {
      const stored = await redis.get(key);
      if (stored === BATCH_STATE_PROCESSING) {
        logger.info("초대권 배치 중복 요청 — 처리 중", { eventId });
        return empty({ inProgress: true, batchFingerprint: fingerprint });
      }
      if (stored) {
        try {
          const prior = JSON.parse(stored) as BulkIssueResult;
          logger.info("초대권 배치 중복 요청 — 저장된 결과 재사용", {
            eventId,
            issued: prior.issued,
          });
          return { ...prior, replayed: true, batchFingerprint: fingerprint };
        } catch {
          // 저장값이 깨졌다 — 재사용할 수 없으니 새로 처리한다(중복 발급 위험보다
          // "아무것도 못 함" 이 낫지 않다고 판단. 깨진 값은 곧 TTL 로 사라진다).
          logger.warn("초대권 배치 저장 결과 파싱 실패 — 재처리", { eventId });
        }
      }
      // 키가 방금 만료됐다(경합) — 그대로 진행한다.
    }
  } catch (err: unknown) {
    logger.error("초대권 배치 멱등 확인 실패 — 발권 거부(fail-closed)", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return empty({
      failed: sendable.length,
      failures: sendable.map((r) => ({
        phone: r.phone,
        reason: "지금 초대권을 발급할 수 없습니다(잠시 후 재시도)",
      })),
    });
  }

  const result = await runBulkIssue({ ...input, sendable, invalid });

  // 결과 보관 — 이후 같은 명단 재업로드는 이 값을 그대로 돌려받는다.
  // ⚠️ 여기까지 못 오면(프로세스 강제종료) 클레임이 10분 뒤 만료돼 재시도가 열린다.
  //    그 재시도는 이미 발급된 순번을 건너뛰고 **추가 발급**하게 된다 — 알려진 한계다.
  //
  // 🔴 **한 장도 발급 못 했으면 캐시하지 않는다** (2026-07-31 실사고).
  //    종전엔 결과를 무조건 7일 보관했다. 그래서 발권이 전부 실패한 배치도 저장돼,
  //    원인을 고쳐 배포해도 **같은 명단은 7일간 재시도가 막혔다** — 화면은
  //    "이미 처리한 명단입니다(앞서 0장 발급됨)" 만 띄운다. prod 에서 실제로 겪었다.
  //
  //    이 캐시의 목적은 **중복 발송 방지** 하나뿐이다. `issued === 0` 이면 나간 것이
  //    없으므로 막을 중복도 없다 ⟹ 캐시할 이유가 없고, 막는 해만 있다.
  //    클레임 키도 지워 10분 대기 없이 곧바로 재시도할 수 있게 한다.
  //
  //    ⚠️ **일부라도 발급됐으면(issued > 0) 그대로 캐시한다.** 실패분이 섞여 있어도
  //    재업로드하면 성공분이 **두 번 나간다**. 그 경우의 구제는 재업로드가 아니라
  //    행별 재발송(`resendInvitation`)이 맡는다.
  try {
    if (result.issued > 0) {
      await redis.set(key, JSON.stringify(result), "EX", BATCH_RESULT_TTL_SECONDS);
    } else {
      await redis.del(key);
      logger.warn("초대권 배치 전건 실패 — 결과를 캐시하지 않는다(재시도 가능)", {
        eventId,
        requested: result.requested,
        failed: result.failed,
        atLimit: result.atLimit,
        invalid: result.invalid,
      });
    }
  } catch (err: unknown) {
    logger.warn("초대권 배치 결과 저장 실패 — 재업로드 방어가 이 배치에는 없다", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  // 지문은 **저장 뒤에** 붙인다 — Redis 에 담기는 값은 종전 그대로 두고(형식 불변),
  // 응답에만 싣는다. 감사로그가 "어느 명단이었나" 를 특정할 수 있어야 하므로
  // 막힌 경우뿐 아니라 성공·강제재발송에도 채운다.
  return { ...result, batchFingerprint: fingerprint };
}

async function runBulkIssue(input: {
  accountId: string;
  eventId: string;
  recipients: BulkRecipientInput[];
  sendable: Array<BulkRecipientInput & { phoneNormalized: string }>;
  invalid: number;
}): Promise<BulkIssueResult> {
  const { accountId, eventId, recipients, sendable: unique, invalid } = input;

  const result: BulkIssueResult = {
    requested: recipients.length,
    issued: 0,
    atLimit: 0,
    invalid,
    failed: 0,
    capExceeded: false,
    failures: [],
  };

  if (unique.length === 0) return result;

  /**
   * 같은 번호의 **다음에 시도할 순번**. 배치 안에서 알아낸 점유 상태를 이어 쓴다 —
   * 없으면 같은 번호가 n줄일 때 매 줄이 1부터 다시 올라가 호출이 n² 로 늘어난다.
   */
  const nextSeq = new Map<string, number>();

  /** 상한이 확인된 번호 — 같은 배치의 남은 줄은 왕복 없이 `atLimit` 으로 센다. */
  const atLimitPhones = new Set<string>();

  /**
   * 🔴 **출발점 프리페치** — 왕복 축소의 본체 (2026-08-09, 상한 5 → 50).
   *
   * 루프는 seq 를 1부터 올려가며 두드린다. 상한이 5 일 땐 최악 5회였지만 50 이면
   * 이미 40장 받은 번호에 **41회**이고, 이 배치는 10,000명까지 온다(bulk 상한)
   * ⟹ 최악 **50만 회**. 이 라우트엔 maxDuration 도 없어 그대로 타임아웃이다.
   *
   * ⚠️ 실패해도 **그냥 진행한다.** 이건 힌트일 뿐이고, 없으면 지금처럼 1부터 두드린다.
   *    힌트를 못 받았다고 대량초대를 막으면 최적화가 장애가 된다.
   */
  try {
    const { next, at_limit } = await invitationNextSeq(
      eventId,
      accountId,
      unique.map((r) => r.phoneNormalized),
    );
    for (const [phone, seq] of Object.entries(next ?? {})) {
      if (Number.isInteger(seq) && seq >= 1) nextSeq.set(phone, seq);
    }
    // 🔴 자리가 없는 번호는 아예 두드리지 않는다. 상한 숫자를 go 가 모르므로
    //    이 목록이 유일한 판별 수단이다 — 없으면 가드까지 헛되이 왕복한다.
    for (const phone of at_limit ?? []) {
      atLimitPhones.add(phone);
      nextSeq.delete(phone);
    }
  } catch (err: unknown) {
    logger.warn("초대권 출발 순번 프리페치 실패 — 1부터 두드린다(느릴 뿐 결과는 같다)", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  // 이벤트 comp 캡 조회. NULL=무제한.
  // 🔴 fail-closed: "이벤트 없음"과 "v2 장애"를 구분한다. 장애는 재시도 가능한 문구로 분리
  //   (발권 자체는 어느 쪽이든 미실행).
  let cap: number | null;
  try {
    const event = await getOwnedEvent(eventId, accountId);
    if (!event) {
      // 이벤트 없음/타테넌트 — 전부 실패로 표기(account 경계 누출 방지, 동일 문구).
      result.failed = unique.length;
      for (const r of unique) result.failures.push({ phone: r.phone, reason: "이벤트를 찾을 수 없습니다" });
      return result;
    }
    cap = event.comp_capacity_cap ?? null;
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      result.failed = unique.length;
      for (const r of unique) {
        result.failures.push({ phone: r.phone, reason: "행사 정보를 확인할 수 없습니다(잠시 후 재시도)" });
      }
      logger.warn("초대권 대량발권 중단: 이벤트 조회 실패", { eventId });
      return result;
    }
    throw err;
  }

  // 이미 발권된 초대권 수(캡 계산 기준). v2 가 account+event 경계로 집계한다.
  // 🔴 조회 실패를 0 으로 강등하면 캡이 무력화돼 초과 발권이 난다 → 중단.
  let currentIssued: number;
  try {
    // limit=1 — 목록은 쓰지 않고 집계(active_count)만 소비한다.
    const res = await listEventInvitations(eventId, accountId, { limit: 1 });
    currentIssued = res.active_count;
  } catch (err: unknown) {
    result.failed = unique.length;
    for (const r of unique) {
      result.failures.push({ phone: r.phone, reason: "발급 현황을 확인할 수 없습니다(잠시 후 재시도)" });
    }
    logger.warn("초대권 대량발권 중단: 발급 현황 조회 실패", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return result;
  }

  // comp 상품 보장(캡을 tier capacity 로 반영 — 최초 생성 시점). 캡 없으면 무제한.
  let comp: { productId: string } | null;
  try {
    comp = await ensureCompProduct(null, eventId, accountId, cap ?? undefined);
  } catch {
    result.failed = unique.length;
    for (const r of unique) result.failures.push({ phone: r.phone, reason: "발권 준비 실패" });
    return result;
  }
  if (!comp) {
    result.failed = unique.length;
    for (const r of unique) result.failures.push({ phone: r.phone, reason: "이벤트가 커머스(v2)에 아직 연결되지 않았습니다" });
    return result;
  }

  for (const r of unique) {
    // 캡 초과 사전 차단(로컬 게이트). v2 tier capacity 가 최종 원자 집행이지만, 여기서 먼저 막아
    // 불필요한 발권 시도를 줄인다.
    if (cap !== null && currentIssued >= cap) {
      result.capExceeded = true;
      continue;
    }

    // 이 번호는 이미 상한으로 확인됐다 — 왕복 없이 집계만 한다.
    // 🔴 종전엔 nextSeq 를 가드 밖으로 밀어 재시도를 막았는데, 그러면 루프가 아예 돌지 않아
    //    **남은 줄이 어디에도 집계되지 않았다**(테스트가 atLimit 1 vs 2 로 잡았다).
    if (atLimitPhones.has(r.phoneNormalized)) {
      result.atLimit += 1;
      continue;
    }

    /**
     * 순번을 올려가며 **빈 자리를 하나 잡는다**(발권 전 원자 예약 = 락 역할 겸용).
     *
     *   created=true                     → 그 순번을 잡았다. 발권으로 진행
     *   created=false                    → 그 순번은 이미 점유(재업로드·동시 패자) → 다음 순번
     *   409 `INVITATION_LIMIT`           → 이 번호는 상한. 이 줄은 미발급으로 집계하고 종료
     *   그 외 오류                        → 실패로 표면화(조용한 미발송 금지)
     *
     * ⚠️ 종료 조건은 **`error.code`** 다. HTTP 409 만 보면 안 된다 —
     *    같은 409 에 `CONFLICT`(동시성, 재시도 대상)가 있다.
     * ⚠️ 회수된 순번은 v2 가 **부활**시켜 `created=true` 를 돌려준다(새 티켓을 발권해야 한다).
     */
    /**
     * 요청용 id — v2 가 **새 행을 만들 때만** 이 값을 쓴다.
     *
     * 🔴 회수된 순번을 되살릴 때 v2 는 **기존 행**(원래 id)을 돌려준다
     *    (`internal_attendee_ledger.py:572-596`). 그래서 이후 호출은 반드시
     *    응답의 `invitation.id` 를 써야 한다 — 이 값을 계속 쓰면 티켓은 발권되는데
     *    `markInvitationIssued` 가 없는 행을 가리켜 **티켓번호가 안 붙는다**
     *    (초대권 링크가 죽는다). 픽스처가 부활을 충실히 모형화해서 잡혔다.
     */
    const requestedInvId = crypto.randomUUID();
    // ⚠️ `string` 으로 명시한다 — randomUUID 의 템플릿 리터럴 타입으로 좁혀지면
    //    v2 응답의 id(평범한 string)를 대입할 수 없다.
    let invId: string = requestedInvId;
    /**
     * 🔴 발권 멱등키의 **세대** — 회수→재발급을 옛 주문 재생과 갈라놓는다 (2026-07-31 실사고).
     *
     * 부활은 **같은 invitation id 를 되살린다**. 그래서 멱등키가 `invitation:${invId}` 뿐이면
     * v2 는 회수된 옛 주문을 찾아 **재생하려 한다**. `token_version` 은 회수마다 +1 이므로
     * 이 값을 키에 넣으면 세대가 갈리고, 재발급이 **새 주문**으로 생성된다.
     * (같은 세대 안의 재시도는 여전히 같은 키 → 멱등 유지.)
     */
    let invTokenVersion = 0;
    let created = false;
    let reserveFailed = false;
    let seq = nextSeq.get(r.phoneNormalized) ?? 1;

    while (seq <= SEQ_LOOP_GUARD) {
      try {
        const res = await reserveInvitation(eventId, accountId, {
          invitation_id: requestedInvId,
          recipient_name: r.name,
          phone_normalized: r.phoneNormalized,
          phone_display: r.phone,
          admission_day: r.admissionDay ?? null,
          admission_mode: r.admissionMode ?? null,
          seq,
        });
        if (res.created) {
          created = true;
          // 🔴 부활 시 기존 행이 온다 — 응답의 id 를 정본으로 삼는다(위 주석).
          invId = res.invitation?.id ?? requestedInvId;
          invTokenVersion = res.invitation?.token_version ?? 0;
          nextSeq.set(r.phoneNormalized, seq + 1);
          break;
        }
        seq += 1; // 점유됨 — 다음 순번.
      } catch (err: unknown) {
        if (v2ErrorCode(err) === "INVITATION_LIMIT") {
          result.atLimit += 1;
          // 같은 번호의 남은 줄도 전부 상한이다 — 헛된 왕복을 막는다.
          atLimitPhones.add(r.phoneNormalized);
          break;
        }
        // 🔴 예약 실패를 "스킵"으로 흘리면 조용한 미발송이 된다 → 실패로 표면화.
        reserveFailed = true;
        result.failed += 1;
        result.failures.push({ phone: r.phone, reason: "초대권 예약에 실패했습니다(잠시 후 재시도)" });
        logger.warn("초대권 예약 실패", {
          eventId,
          phone: r.phoneNormalized,
          seq,
          code: v2ErrorCode(err),
          error: err instanceof Error ? err.message : "unknown",
        });
        break;
      }
    }

    if (!created) {
      // 방어 상한까지 갔는데 자리를 못 잡았다 = v2 가 409 를 안 줬는데도 계속 점유였다.
      // 조용히 넘기면 "보냈다고 믿는데 안 간" 상태가 되므로 실패로 남긴다.
      if (!reserveFailed && result.atLimit === 0 && seq > SEQ_LOOP_GUARD) {
        result.failed += 1;
        result.failures.push({ phone: r.phone, reason: "초대권 순번을 확보하지 못했습니다" });
        logger.error("초대권 순번 확보 실패 — 방어 상한 도달", {
          eventId,
          phone: r.phoneNormalized,
          guard: SEQ_LOOP_GUARD,
        });
      }
      continue;
    }

    // comp 발권(v2 write-through). raffle_number(F4)·admission_day(F1)는 v2 가 부여.
    try {
      const order = await createOrder({
        accountId,
        eventId,
        buyerName: r.name,
        // 전화-only 초대객 — 가짜 이메일(게스트 resolve). 딥링크 bearer 로 열람(P0-2).
        // 🔴 `Date.now()` 를 쓰지 않는다 (2026-07-31 실사고 — IDEMPOTENCY_KEY_MISMATCH).
        //    v2 는 멱등 재생 전에 **저장된 게스트 이메일과 요청 이메일을 대조**한다
        //    (`_assert_order_replay_owner`). 매번 값이 달라지면 정당한 재시도조차 409 로 막힌다.
        //    초대당 고정값이어야 한다.
        buyerEmail: `invite-${invId}@no-reply.pickket.kr`,
        buyerPhone: r.phone,
        items: [{ productId: comp.productId, quantity: 1, admissionDay: r.admissionDay ?? null }],
        paymentMethod: "offline",
        status: "completed",
        paymentStatus: "paid",
        totalAmountOverride: 0,
        paidAmount: 0,
        source: "direct",
        answers: { _invitation: "true", _invitationId: invId },
        idempotencyToken: `invitation:${invId}:v${invTokenVersion}`,
      });

      // 발권된 티켓번호 — createOrder 가 v2 응답에서 파생한 ticketNumbers 를 돌려준다.
      const ticketNumber = order.ticketNumbers[0] ?? null;

      // 원장 앵커 갱신 + 발송 큐 적재를 **v2 한 트랜잭션**으로(옛 go 2쿼리 사이의 crash 창 제거).
      await markInvitationIssued(invId, accountId, ticketNumber);

      currentIssued += 1;
      result.issued += 1;
    } catch (err: unknown) {
      // 발권 실패 — 원장 행을 failed 로 남겨 재발송/진단 가능하게. (큐 미적재)
      //
      // 🔴 종전에는 V2CommerceError 를 전부 "커머스 동기화 실패(잠시 후 재발송)" 한 문구로
      //    뭉개고 `status`·`body` 를 **버렸다**. 그래서 원장·로그 어디에도 원인이 남지 않고
      //    "상품 미연결(4xx, 재시도해도 안 됨)" 과 "v2 일시장애(5xx, 재시도하면 됨)" 가
      //    **구분되지 않았다.** 주최자에게는 "잠시 후 재발송" 이라고 안내하는데 실제로는
      //    영원히 안 되는 경우가 있다. 실측(2026-07-30 §5): 발권 6건이 이 문구만 남겨
      //    원인을 좁히려면 코드를 읽어야 했다.
      //
      // 사용자 문구는 재시도 가능성으로 가른다. 진단 정보(status·code)는 로그에 남긴다
      // — v2 내부 영문 메시지를 주최자 화면에 노출하지 않는다.
      const status = err instanceof V2CommerceError ? err.status : null;
      const code = v2ErrorCode(err);
      const retryable = status === null || status >= 500;
      const reason = err instanceof V2CommerceError
        ? retryable
          ? "커머스 동기화 실패(잠시 후 재발송)"
          : `발권 설정 문제로 실패했습니다(관리자 확인 필요${code ? ` · ${code}` : ""})`
        : err instanceof Error ? err.message : "알 수 없는 오류";
      await markInvitationFailedV2(invId, accountId, reason).catch(() => undefined);
      result.failed += 1;
      result.failures.push({ phone: r.phone, reason });
      logger.warn("초대권 발권 실패", {
        eventId,
        phone: r.phoneNormalized,
        seq,
        status,
        code,
        // 원인 본문 앞부분만 — 진단에 필요하고 전체는 로그를 오염시킨다.
        detail: err instanceof V2CommerceError ? err.body?.slice(0, 300) : undefined,
        reason,
      });
    }
  }

  return result;
}

const CLAIM_LIMIT = 100;         // 한 tick 처리 초대 수(NCP 배치 ~100/콜 정합).
const CLAIM_LEASE_MINUTES = 5;   // sending 리스 만료(스톨 회수).

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  requestId: string | null;
}

/**
 * 외부 발송 멱등키 — **안정 파생**(랜덤 금지).
 *
 * 같은 배치를 다시 발송하려는 시도(리스 만료 재클레임 = crash 재시도)는 같은 키를 얻어야
 * NCP 가 dedup 한다. 반대로 주최자의 명시적 재발송은 달라야 실제로 나간다. 그 둘을 가르는
 * 것이 `send_epoch` 다(재발송에서만 +1). dispatchId 는 초대당 고정(UNIQUE invitation_id).
 */
export function deriveDispatchIdempotencyKey(
  items: Array<{ dispatchId: string; sendEpoch: number }>,
): string {
  const seed = items
    .map((i) => `${i.dispatchId}:${i.sendEpoch}`)
    .sort()
    .join(",");
  return `invite-dispatch:${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

/**
 * 발송 큐 드레인 — cron(호스트 스케줄러)이 주기 호출. claim-lease 로 동시 안전.
 *
 * 멱등·이중발송 방지:
 *  - queued + 스톨 sending(리스 만료) 을 v2 가 조건부 UPDATE 로 원자 claim → sending 전이.
 *  - 배치 발송 후 claim_token 이 여전히 자기 것일 때만 결과 반영(늦게 돌아온 이전 워커의
 *    덮어쓰기 차단).
 *  - 외부 발송 멱등키는 claim_token(랜덤)이 아니라 dispatchId+sendEpoch 에서 파생한다.
 *  - NCP 실발송은 게이트2(자격 완비) 후. dev/미설정은 stub(발송 성공으로 간주해 상태만 전이).
 */
export async function drainInvitationDispatch(): Promise<DrainResult> {
  const claimToken = crypto.randomUUID();

  // 1) queued + 스톨 sending 클레임(동시 안전). v2 응답이 원장 필드까지 함께 준다.
  const { items: claimed } = await claimInvitationDispatch({
    claim_token: claimToken,
    limit: CLAIM_LIMIT,
    lease_minutes: CLAIM_LEASE_MINUTES,
  });

  const out: DrainResult = { claimed: claimed.length, sent: 0, failed: 0, requestId: null };
  if (claimed.length === 0) return out;

  // 2) 이벤트 정보(v2). 🔴 fail-closed: 조회 실패한 이벤트의 항목은 **발송하지 않고 큐로
  //    되돌린다** — 제목/일자를 폴백 문구로 채워 보내면 잘못된 안내가 실제로 나가고,
  //    알림톡은 회수 불가다.
  type EventInfo = { title: string; venue: string | null; startsAt: string | null; endsAt: string | null };
  const eventInfo = new Map<string, EventInfo>();
  for (const eventId of new Set(claimed.map((c) => c.event_id))) {
    try {
      const ev = await getEvent(eventId);
      eventInfo.set(eventId, {
        title: ev.title,
        venue: ev.venue ?? null,
        startsAt: ev.event_date,
        endsAt: ev.event_date_end ?? null,
      });
    } catch (err: unknown) {
      logger.warn("초대권 드레인: 이벤트 정보 조회 실패(해당 항목 재큐잉)", {
        eventId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  const tpl = ALIMTALK_TEMPLATES.INVITATION_ISSUED;
  const smsFrom = SMS_FROM();
  const items: Array<{
    to: string;
    content: string;
    buttons: AlimtalkButton[];
    failover?: AlimtalkFailover;
    dispatchId: string;
    invitationId: string;
    sendEpoch: number;
  }> = [];
  // 티켓번호 없는(발권 미완) 항목 + 이벤트 정보 조회 실패 항목 — 발송 불가 → 재큐잉.
  const unbuildable: string[] = [];

  for (const c of claimed) {
    if (!c.ticket_number) {
      unbuildable.push(c.dispatch_id);
      continue;
    }
    const ev = eventInfo.get(c.event_id);
    if (!ev) {
      unbuildable.push(c.dispatch_id);
      continue;
    }
    // 만료 = 이벤트 종료 + 30일(폴백). ends_at 없으면 토큰 기본 TTL.
    const endsAtMs = ev.endsAt == null ? NaN : Date.parse(ev.endsAt);
    const expiresAt = Number.isNaN(endsAtMs) ? undefined : endsAtMs + 30 * 24 * 60 * 60 * 1000;
    const token = createInvitationToken({
      ticketNumber: c.ticket_number,
      version: c.token_version,
      expiresAt,
    });
    const inviteUrl = `${APP_ORIGIN()}/tickets/${encodeURIComponent(c.ticket_number)}?${INVITE_TOKEN_PARAM}=${token}`;
    // 대회일자: 수신자 지정일(F1 daypass)이 있으면 그 날, 없으면 행사 전체 기간(KST).
    const eventDate = c.admission_day
      ? formatEventDayKo(c.admission_day)
      : formatEventDateKo(ev.startsAt, ev.endsAt);
    const venueName = ev.venue?.trim() || "행사 안내 참조";
    const content = tpl.body({
      eventTitle: ev.title,
      eventDate,
      venueName,
    });
    // 링크는 '모바일 티켓' 웹링크 버튼으로 전달(승인 템플릿 버튼과 일치).
    const buttons: AlimtalkButton[] = [
      { type: "WL", name: "모바일 티켓", linkMobile: inviteUrl, linkPc: inviteUrl },
    ];
    // SMS 대체 발신번호가 설정된 경우에만 failover 구성(버튼이 SMS엔 없으므로 링크를 본문 텍스트로 포함).
    const failover: AlimtalkFailover | undefined = smsFrom
      ? {
          type: "LMS",
          from: smsFrom,
          subject: ev.title.slice(0, 40),
          content: `${content}\n\n▶ 모바일 티켓 확인: ${inviteUrl}`,
        }
      : undefined;
    items.push({
      to: c.phone,
      content,
      buttons,
      failover,
      dispatchId: c.dispatch_id,
      invitationId: c.invitation_id,
      sendEpoch: c.send_epoch,
    });
  }

  // 발권 미완(티켓번호 없음) — 큐로 되돌려 다음 tick 재시도(발권 UPDATE 가 아직 안 보였을 수 있음).
  if (unbuildable.length > 0) {
    await requeueInvitationDispatch({ claim_token: claimToken, dispatch_ids: unbuildable });
  }

  if (items.length === 0) return out;

  // 3) 실발송 — 자격 완비(게이트2) 시 NCP 배치, 아니면 stub(성공 간주).
  //
  // 🔴 배치는 **부분 실패**한다. 한 명이 접수 거부돼도 나머지는 나간다. 옛 코드는
  //    배치 전체를 하나의 sendOk 로 접어서, 거부된 수신자까지 "발송됨" 으로 기록했다.
  //    (실측: 버튼 링크 불일치로 접수는 A000 인데 카카오가 전달을 거부 → 미도달.
  //     발송 응답의 수신자별 코드를 안 보면 이 차이가 원장에 남지 않는다.)
  let requestId: string | null = null;
  let sendError: string | null = null;
  // 접수 거부된 수신번호 → 사유. 여기 없으면 접수 성공으로 본다.
  const rejectedByPhone = new Map<string, string>();
  const digits = (v: string) => v.replace(/[^0-9]/g, "");
  try {
    if (hasAlimtalkCredentials()) {
      const res = await sendAlimtalkBatch(
        tpl.code,
        items.map((i) => ({ to: i.to, content: i.content, buttons: i.buttons, failover: i.failover })),
        { idempotencyKey: deriveDispatchIdempotencyKey(items) },
      );
      requestId = res.requestId || null;
      for (const r of res.results) {
        if (!r.ok) rejectedByPhone.set(r.to, `알림톡 접수 거부(${r.code ?? "-"}): ${r.desc ?? ""}`.trim());
      }
    } else {
      // dev/미설정 — stub. 실발송 없이 상태만 전이(게이트2 전 개발 흐름 유지).
      logger.info("초대권 알림톡 발송 stub(자격 미설정)", { count: items.length });
    }
    out.requestId = requestId;
  } catch (err: unknown) {
    // 배치 호출 자체가 실패 — 전원 미발송으로 본다(fail-closed).
    sendError = err instanceof Error ? err.message : "알림톡 배치 발송 실패";
    logger.error("초대권 알림톡 배치 발송 실패", { error: sendError, count: items.length });
  }

  // 4) 결과 반영 — claim_token 이 아직 자기 것일 때만(늦은 이전 워커 덮어쓰기 차단).
  //    성공분과 실패분을 **나눠서** 반영한다(부분 실패를 통째로 성공/실패로 접지 않는다).
  const sentItems = sendError ? [] : items.filter((i) => !rejectedByPhone.has(digits(i.to)));
  const failedItems = sendError ? items : items.filter((i) => rejectedByPhone.has(digits(i.to)));

  if (sentItems.length > 0) {
    await completeInvitationDispatch({
      claim_token: claimToken,
      dispatch_ids: sentItems.map((i) => i.dispatchId),
      invitation_ids: sentItems.map((i) => i.invitationId),
      sent: true,
      request_id: requestId,
      error: null,
    });
  }
  if (failedItems.length > 0) {
    await completeInvitationDispatch({
      claim_token: claimToken,
      dispatch_ids: failedItems.map((i) => i.dispatchId),
      invitation_ids: failedItems.map((i) => i.invitationId),
      sent: false,
      request_id: requestId,
      error: sendError ?? rejectedByPhone.get(digits(failedItems[0]!.to)) ?? "알림톡 접수 거부",
    });
  }
  out.sent = sentItems.length;
  out.failed = failedItems.length;

  return out;
}

/**
 * 입장 가능 범위(YYYY-MM-DD ~ YYYY-MM-DD) 문자열.
 *
 * ⚠️ v2 응답은 ISO 문자열이지만, 과거 pg 드라이버 경로가 Date 객체를 넘기던 호출부가 남아
 * 있을 수 있어 두 형태를 모두 안전하게 처리한다(과거 버그: allpass/single 초대는
 * admission_day=null → 이 분기 → Date.slice TypeError 로 드레인 tick 전체 크래시 → 미발송).
 */
function toYmd(value: Date | string): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  // 문자열: 이미 ISO(YYYY-MM-DD...) 면 앞 10자, 아니면 Date 파싱 후 정규화.
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Date/문자열 → Date(유효하지 않으면 null). */
function toDate(value: Date | string | null): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "2025년 10월 16일(목)" — KST 기준 한글 날짜(요일 괄호). 알림톡 #{eventDate} 슬롯용. */
function formatEventDayKo(value: Date | string): string {
  const d = toDate(value);
  if (!d) return "행사 안내 참조";
  // 🔴 공용 포맷터를 쓴다 — KST 규칙이 여러 곳에 흩어지면 한쪽만 고쳐진다(2026-08-01 정리).
  //    ⚠️ 이 값은 **알림톡 승인 슬롯**에 그대로 실린다. 치환 전후 출력이 완전히 같은 것을
  //       표본 5개로 확인했다(`2026년 8월 20일(목)` 형태 유지).
  //    ⚠️ 스프레드(`{...opts}`)로 넘기지 않는다 — 가드가 옵션을 못 읽어 놓친다.
  return `${formatDateKst(d, "")}(${formatWeekdayKst(d)})`;
}

/** 대회일자 문자열(KST). 시작=종료면 단일일, 다르면 "시작 ~ 종료". 시작 없으면 폴백. */
function formatEventDateKo(startsAt: Date | string | null, endsAt: Date | string | null): string {
  const start = toDate(startsAt);
  if (!start) return "행사 안내 참조";
  const end = toDate(endsAt);
  const startStr = formatEventDayKo(start);
  if (!end || toYmd(start) === toYmd(end)) return startStr;
  return `${startStr} ~ ${formatEventDayKo(end)}`;
}

/**
 * 초대 회수/취소 — 딥링크 nonce 증가(구 링크 무효) + 원장 revoked + 대기 큐 제거.
 * v2 가 세 가지를 한 트랜잭션으로 수행한다.
 * @returns 회수 여부(이미 회수됨이면 false).
 * @throws V2CommerceError — 호출부가 명시적으로 처리(장애를 "회수됨"으로 위장 금지).
 */
export async function revokeInvitation(input: {
  accountId: string;
  eventId: string;
  invitationId: string;
}): Promise<boolean> {
  const { revoked, invitation } = await revokeInvitationV2(input.invitationId, input.accountId);
  if (!revoked) return false;

  // 🔴 2026-07-31 실측 사고 — 회수가 **v2 티켓만** 죽이고 go 참석자를 안 건드렸다.
  //
  //    회수 후 상태:  v2 티켓 cancelled ✅ · go 주문 confirmed(그대로) · go 참석자 confirmed 🔴
  //
  //    발송 세그먼트(`lib/notification/recipients.ts`)는 **주문 상태 + 참석자 상태**를
  //    보는데, 초대권 회수는 주문을 건드리지 않으므로 두 조건을 **다 통과**한다.
  //    ⟹ **회수당한 사람에게 공지·리마인더가 계속 나간다.** prod 원장에서 4건 실측됐다.
  //
  //    주문취소·환불 cascade 와 **같은 방식**으로 참석자를 죽인다(상태머신 우회 직접
  //    UPDATE — v2 SSOT 투영이라 go 상태머신의 전이 허용 여부와 무관하다).
  //
  //    ⚠️ `checked_in` 은 건드리지 않는다. 이미 입장한 사람의 이력을 지우면
  //       재입장이 열리고, 발송 세그먼트에서도 입장자 대상 안내가 끊긴다.
  //    ⚠️ best-effort — 이 투영이 실패해도 회수 자체(v2 티켓 무효화)는 이미 성립했다.
  //       실패를 회수 실패로 되돌리면 "티켓은 죽었는데 회수 안 됐다" 로 보인다.
  const ticketNumber = invitation?.ticket_number ?? null;
  if (ticketNumber) {
    try {
      const pool = getPool();
      const res = await pool.query(
        `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
          WHERE ticket_number = $1 AND status NOT IN ('cancelled', 'checked_in')`,
        [ticketNumber],
      );
      if ((res.rowCount ?? 0) === 0) {
        logger.info("초대권 회수 — 취소할 참석자 없음(이미 취소·입장했거나 투영 없음)", {
          invitationId: input.invitationId, ticketNumber,
        });
      }
    } catch (err: unknown) {
      // 조용히 넘기지 않는다 — 안 죽은 참석자는 발송 세그먼트에 남는다.
      logger.error("🔴 초대권 회수 후 참석자 투영 실패 — 발송 세그먼트에 남는다", {
        invitationId: input.invitationId,
        ticketNumber,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  } else {
    logger.warn("초대권 회수 — ticket_number 없음(발권 전 회수). 참석자 투영 생략", {
      invitationId: input.invitationId,
    });
  }
  return revoked;
}

/**
 * 재발송 — 초대를 큐에 재적재한다.
 *
 * ⚠️ 옛 주석은 "failed 초대를" 이라고 적혀 있었으나 **틀렸다**(2026-08-04 배포본 :52 실측).
 *    v2 가 거르는 것은 두 가지뿐이다:
 *      · `status == "revoked"`      → 409
 *      · `ticket_number` 없음(발권 미완) → requeued:false, reason "not_issued"
 *    🔴 `status == "failed"` 조건은 없다. `issued` 도 그대로 재적재된다 — 큐에 안 들어가
 *       23시간 멈춰 있던 5건이 이 경로로 풀렸다. go 래퍼도 상태로 거르지 않는다.
 *
 * 🔴 이 경로만 `send_epoch` 를 올린다 — 그래야 "재시도(같은 키·중복발송 없음)" 와
 *    "재발송(새 키·실제 발송)" 이 구분된다.
 * @returns 재큐잉 성공 여부.
 */
export async function resendInvitation(input: {
  accountId: string;
  eventId: string;
  invitationId: string;
}): Promise<{ requeued: boolean; reason?: string }> {
  // 🔴 v2 가 주는 `reason` 을 버리지 않는다. 종전엔 `requeued` 만 읽고 실패 사유를 삼켜,
  //    화면은 어떤 이유로 막혔든 "발권 미완" 한 줄만 보여줬다 — 주최자가 조치를 고를 수 없다.
  const { requeued, reason } = await resendInvitationV2(input.invitationId, input.accountId);
  return { requeued, reason };
}

/**
 * 티켓 열람 훅 — 딥링크로 초대권 페이지가 열리면 viewed 로 전이(이미 checked_in 이면 유지).
 * ticket_number 로 초대를 찾아 갱신. 유료/일반 티켓은 매칭 없음(무영향).
 *
 * best-effort: 열람 추적 실패가 티켓 화면 렌더를 막지 않는다(표시용 지표).
 */
export async function markInvitationViewed(ticketNumber: string): Promise<void> {
  await markInvitationByTicketNumber(ticketNumber, "viewed").catch((err: unknown) => {
    logger.warn("초대권 열람 추적 실패", {
      ticketNumber,
      error: err instanceof Error ? err.message : "unknown",
    });
  });
}

/**
 * 체크인 훅 — 티켓 체크인 시 초대를 checked_in 으로 전이(F1 admit 경로에서 호출).
 * revoked 는 건드리지 않는다.
 *
 * best-effort: 입장 정본은 v2 `event_admissions` 이고 이건 초대권 추적 지표다.
 * 실패해도 관람객을 막지 않는다(로그로 표면화).
 */
export async function markInvitationCheckedIn(ticketNumber: string): Promise<void> {
  await markInvitationByTicketNumber(ticketNumber, "checked_in").catch((err: unknown) => {
    logger.warn("초대권 입장 추적 실패", {
      ticketNumber,
      error: err instanceof Error ? err.message : "unknown",
    });
  });
}

/**
 * 🔴 알림톡 전달 상태 대사 — "접수됨"을 "도달함"으로 착각하지 않기 위한 단계.
 *
 * ## 왜 필요한가 (실측 2026-07-28, 실계정 발송)
 * 버튼 링크가 승인 템플릿과 어긋난 발송이 이렇게 돌아왔다:
 *
 *     requestStatusCode = "A000"  (접수 성공 — 발송 응답에 실려 온다)
 *     messageStatusCode  = "3027" (전달 실패 "버튼 내용이 템플릿과 불일치" — 나중 조회로만 보인다)
 *
 * 즉 **카톡이 도착하지 않았는데 원장에는 sent** 로 남고 주최자 화면에도 발송 완료로 떴다.
 * 대회 당일이면 수백 명이 초대권을 못 받은 채 아무도 모른다. 이 함수가 그 구간을 닫는다.
 *
 * ## 동작
 *  1. v2 에서 도달 미확인 발송을 받아온다(발송 후 유예 경과분만 — 너무 이르면 코드가 비어 있다).
 *  2. requestId 별로 SENS 를 **한 번씩** 조회한다(배치 1건 = 조회 1회).
 *  3. 수신번호로 매칭해 도달/미도달을 v2 에 돌려준다. 미도달은 sent → failed.
 *
 * ## 판정 원칙
 *  - 응답에 없는 수신자·코드 없는 수신자는 **도달로 보지 않는다**(fail-closed). 다만
 *    이 tick 에서는 결과를 보내지 않고 **다음 tick 으로 넘긴다** — 전달 결과가 아직
 *    안 잡힌 것과 진짜 미도달을 구분할 수 없기 때문이다. 무한 재조회는 v2 의 대사 시한
 *    (48h)이 끊는다.
 *  - 조회 자체가 실패한 requestId 는 건너뛴다(상태를 함부로 실패로 바꾸지 않는다).
 */
export async function reconcileInvitationDelivery(
  options: { limit?: number } = {},
): Promise<{ candidates: number; checked: number; undelivered: number; pending: number }> {
  const out = { candidates: 0, checked: 0, undelivered: 0, pending: 0 };
  if (!hasAlimtalkCredentials()) return out; // stub 발송분은 대사 대상이 아니다.

  const { items } = await listPendingDeliveryCheck({ limit: options.limit ?? 200 });
  out.candidates = items.length;
  if (items.length === 0) return out;

  // requestId 별로 묶어 조회 횟수를 발송 배치 수만큼으로 줄인다.
  const byRequest = new Map<string, typeof items>();
  for (const it of items) {
    const list = byRequest.get(it.request_id);
    if (list) list.push(it);
    else byRequest.set(it.request_id, [it]);
  }

  const digits = (v: string) => v.replace(/[^0-9]/g, "");
  const checked: Array<{
    dispatch_id: string;
    invitation_id: string;
    delivered: boolean;
    code?: string | null;
    desc?: string | null;
  }> = [];

  for (const [requestId, group] of byRequest) {
    let statuses: Awaited<ReturnType<typeof fetchAlimtalkDeliveryStatus>>;
    try {
      statuses = await fetchAlimtalkDeliveryStatus(requestId);
    } catch (err: unknown) {
      // 조회 실패는 판정 근거가 아니다 — 다음 tick 에 다시 본다.
      logger.warn("알림톡 전달 상태 조회 실패(다음 tick 재시도)", {
        requestId,
        error: err instanceof Error ? err.message : "unknown",
      });
      out.pending += group.length;
      continue;
    }
    const byPhone = new Map(statuses.map((st) => [digits(st.to), st]));
    for (const it of group) {
      const st = byPhone.get(digits(it.phone));
      if (!st || st.code === null) {
        // 아직 전달 결과가 안 잡혔다 — 미도달로 단정하지 않고 다음 tick 으로.
        out.pending += 1;
        continue;
      }
      checked.push({
        dispatch_id: it.dispatch_id,
        invitation_id: it.invitation_id,
        delivered: st.delivered,
        code: st.code,
        desc: st.desc,
      });
    }
  }

  if (checked.length > 0) {
    const res = await reportInvitationDeliveryResult({ checked });
    out.checked = checked.length;
    out.undelivered = res.undelivered;
    if (res.undelivered > 0) {
      // 미도달은 조용히 넘기면 안 된다 — 손님이 티켓을 못 받은 상태다.
      logger.error("🔴 알림톡 미도달 확인 — 초대권이 전달되지 않았습니다", {
        undelivered: res.undelivered,
        samples: checked
          .filter((c) => !c.delivered)
          .slice(0, 3)
          .map((c) => ({ code: c.code, desc: c.desc })),
      });
    }
  }
  return out;
}
