import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
// W5-ATTENDEE: `check_in_lists`·`check_in_logs` 도 v2 정본으로 이관됐다. 이 라우트에 남은
// go 테이블은 **1개**뿐이다:
//   · `attendees` — **write 전용 투영 캐시**. 발송 세그먼트(lib/notification/recipients.ts)가
//                   `attendees.status = 'checked_in'` 으로 대상을 고르므로 v2 입장 성공 후
//                   상태를 동기화한다. 여기서 read 하지는 않는다(정본은 v2).
//                   ⚠️ 이 테이블은 메시징/주문 트랙 소유라 W5 범위 밖이다(mig252 DROP 대상 아님).
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { projectToGoAttendeeStatus } from "@/lib/domain-model";
import { canTransitionAttendee } from "@/lib/state-machine/attendee-state-machine";
import { MAX_TOLERANCE_WINDOWS } from "@/lib/ticket/dynamic-qr";
import { resolveScanPayload } from "@/lib/checkin/admit";
import { deriveTicketNumber } from "@/lib/ticket/ticket-number";
import type { AttendeeStatus } from "@/lib/types";
import {
  checkInTicket,
  deleteCheckInLogs,
  getCheckInList,
  recordCheckInLog,
  revokeAdmission,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { resolveOwnedTicket, resolveOwnedTicketByNumber, TicketAccessError } from "@/lib/v2/ticket-access";
import type { TicketDetail } from "@/lib/v2/commerce-client";
import { dispatchWebhook } from "@/lib/webhook/dispatcher";
import { markInvitationCheckedIn } from "@/lib/server/invitations";

type Params = { eventId: string };

// §13 캡처방지: 스캔(scan)과 수기입력(manual)을 의도적으로 분리한다.
// - scan: 회전 QR 페이로드(PKT:id:ts:hmac)만 수락. 비-PKT 스캔은 거부(정적 QR 위조 우회 차단).
//   자동 폴백 없음 — 스캐너가 임의 문자열을 티켓번호로 통과시키던 보안구멍을 봉쇄.
// - manual: 명시적 스태프 액션(사유 필수). 티켓번호로 직접 매칭. 스캐너에서 자동 유입 불가.
const schema = z
  .object({
    mode: z.enum(["scan", "manual"]),
    // scan: 스캐너 디코드 원문(PKT:...). manual: 스태프가 입력한 티켓번호.
    scanPayload: z.string().optional(),
    ticketNumber: z.string().optional(),
    attendeeId: z.string().uuid().optional(),
    manualReason: z.string().min(1).max(200).optional(),
    checkInListId: z.string().uuid(),
    // §13 QR 창 확대 킬스위치 — 스태프가 켠 경우 스캔 경로에 넓은 tolerance 전달(회전 QR
    // 갱신 실패 대비). 서버는 상한(MAX)으로 clamp.
    qrToleranceWindows: z.number().int().min(1).max(MAX_TOLERANCE_WINDOWS).optional(),
    // §13 오프라인 동기화 origin. "offline_sync" = 온라인 복귀 시 로컬 큐 배치 전송(회전 QR
    // 미검증·육안 대조 기록). 로그 method="offline", 감사 mode="offline" 로 구분. manual 경로만 허용.
    origin: z.enum(["live", "offline_sync"]).optional(),
    // 오프라인 현장 실입장 시각(ISO). offline_sync 에서만 의미(로그·감사 근거).
    offlineCheckedInAt: z.string().datetime().optional(),
  })
  .refine((v) => (v.mode === "scan" ? !!v.scanPayload : !!(v.ticketNumber || v.attendeeId)), {
    message: "scan 은 scanPayload, manual 은 ticketNumber/attendeeId 가 필요합니다",
  })
  .refine((v) => (v.mode === "manual" ? !!v.manualReason : true), {
    message: "수동 체크인은 사유가 필요합니다",
  })
  // 오프라인 동기화는 스캔 페이로드를 오프라인에 캡처할 수 없으므로 manual(티켓번호) 경로만 허용.
  .refine((v) => (v.origin === "offline_sync" ? v.mode === "manual" : true), {
    message: "오프라인 동기화는 수동(manual) 경로만 허용됩니다",
  });

/**
 * v2 에러 메시지에서 게이트에 보여줄 **관객용 사유**만 뽑는다.
 *
 * `commerce-client.ts:156` 이 `${code}: ${message}` 로 합쳐 던지므로 접두어를 벗긴다.
 * 벗긴 결과에 한글이 없으면 내부 영문 메시지(예: "cannot admit a cancelled ticket")이므로
 * 노출하지 않고 `null` 을 돌려준다 — 현장 스태프에게 영문 내부 문구를 보이면 안 된다.
 */
export function stripV2ErrorCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const withoutCode = raw.replace(/^[A-Z][A-Z0-9_]*:\s*/, "").trim();
  if (!withoutCode) return null;
  return /[가-힣]/.test(withoutCode) ? withoutCode : null;
}

/**
 * 요청 본문 파싱 — ZodError 를 **400 + 사유**로 바꾼다.
 *
 * 🔴 2026-07-28 실측: `schema.parse()` 를 try 없이 부르고 있어 필수 필드가 빠지면
 *    ZodError 가 그대로 올라가 **본문 없는 500** 이 나갔다. 게이트 현장에서 500 은
 *    "서버가 죽었다"로 읽혀 스태프가 스캔을 멈춘다 — 실제로는 요청이 잘못된 것뿐이다.
 *    organizer 의 다른 89개 라우트는 전부 이 패턴을 쓰는데 여기만 빠져 있었다.
 */
async function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  request: Request,
): Promise<z.infer<T> | Response> {
  // 🔴 `request.json()` 도 **이 안에서** 부른다. 종전에는 호출측이
  //    `parseBody(schema, await request.json())` 로 썼는데, 본문이 비었거나 JSON 이
  //    아니면 `request.json()` 이 먼저 던져 이 함수에 **도달하지 못했다** —
  //    withAuth 의 catch 로 떨어져 500 + "인증 처리 실패" 로그(원인 위장)가 났다.
  //    ⟹ f9d3b78 이 "본문 없는 500" 을 고쳤다고 했지만 절반만 고친 상태였다.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse("요청 본문이 올바른 JSON 이 아닙니다", 400);
  }
  try {
    return schema.parse(raw) as z.infer<T>;
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }
}

export const POST = withRole<Params>("staff", async (request, { session, params }) => {
  const parsed = await parseBody(schema, request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  // 스캔 경로: PKT 회전 페이로드만 수락. HMAC·시간창 검증 통과분만 ticket_number 로 사용.
  // 비-PKT(정적 QR/임의문자열)은 거부 — 회전 QR 재제시 안내. 수기입력으로 자동 폴백하지 않는다.
  let resolvedTicketNumber: string | null = null;
  if (body.mode === "scan") {
    // 🔴 현장업체 API(`/api/onsite/checkin`)와 **같은 함수**를 쓴다. 두 벌로 두면
    //    다음에 한쪽만 고쳐지고, 게이트에서 두 스캐너가 다른 판정을 낸다.
    const scan = resolveScanPayload(body.scanPayload ?? "", body.qrToleranceWindows);
    if (!scan.ok) {
      return errorResponse(scan.message, 400);
    }
    resolvedTicketNumber = scan.ticketNumber;
  } else {
    // 수동 경로: 스태프가 명시적으로 입력한 티켓번호(사유 기록). attendeeId 직접 지정도 허용.
    resolvedTicketNumber = body.ticketNumber ?? null;
  }
  const isOffline = body.origin === "offline_sync";
  const isManual = body.mode === "manual";
  // 오프라인 동기화는 현장 실입장 시각을 로그·감사 근거로 보존(서버 기록 시각과 별개).
  const offlineAt = isOffline ? body.offlineCheckedInAt ?? null : null;

  const pool = getPool();

  // ── 1) 체크인 리스트 검증 (W5-ATTENDEE: v2 정본) ──
  //
  // 🔴 fail-closed: 리스트 조회 실패를 "활성 리스트 아님(400)"으로 흘리지 않는다. 400 은
  //    현장에서 "설정이 잘못됐다"로 읽혀 스태프가 명단을 다시 만들게 만든다. 조회 자체가
  //    안 된 것은 **모른다는 뜻**이므로 503 으로 끊는다(실제 미존재/비활성만 400).
  let list: { id: string; status: string; productIds: string[] };
  try {
    const res = await getCheckInList(params.eventId, body.checkInListId, session.accountId);
    list = { id: res.list.id, status: res.list.status, productIds: res.list.product_ids };
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) {
        return errorResponse("활성화된 체크인 리스트가 아닙니다", 400);
      }
      logger.error("체크인 리스트 조회 실패", {
        eventId: params.eventId,
        listId: body.checkInListId,
        status: err.status,
      });
      return errorResponse("체크인 명단을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (list.status !== "active") {
    return errorResponse("활성화된 체크인 리스트가 아닙니다", 400);
  }

  // ── 2) 티켓 해석 (W4-ORD: go attendees SELECT ... FOR UPDATE 폐기) ──
  //
  // 옛 경로는 go `attendees` 를 티켓번호로 찾아 ① 테넌트 경계 ② v2_ticket_id ③ 표시값(이름·상태)
  // 을 얻고, 그 위에 상품명 보강용 v2 단건 조회를 **한 번 더** 얹었다. 이제 v2 단건 조회 하나가
  // 그 넷을 전부 준다(event_id·go_account_id 로 경계 강제, buyer.name 으로 표시명).
  //
  // 🔴 동시성: 옛 `FOR UPDATE OF attendees` 를 없앴지만 **이중 입장은 불가능하다**. 입장 멱등의
  //    정본은 처음부터 go 락이 아니라 v2 `event_admissions`(티켓 행 FOR UPDATE) 였고, 동시 2회
  //    스캔 시 v2 가 직렬화해 한쪽에만 already:false 를 준다 → check_in_logs 도 1행만 남는다.
  //    go 락은 오히려 v2 왕복 시간만큼 go 커넥션을 잡고 있었다.
  //
  // 🔴 fail-closed: v2 조회 실패를 "등록되지 않은 티켓(404)"으로 위장하지 않는다 → 503.
  //    게이트 현장에서 404 는 "이 사람 표가 가짜다"로 읽힌다.
  let ticket: TicketDetail | null;
  try {
    ticket = resolvedTicketNumber
      ? await resolveOwnedTicketByNumber(resolvedTicketNumber, params.eventId, session.accountId)
      : body.attendeeId
        ? await resolveOwnedTicket(body.attendeeId, params.eventId, session.accountId)
        : null;
  } catch (err: unknown) {
    if (err instanceof TicketAccessError) {
      return errorResponse("티켓 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  if (!ticket) {
    return errorResponse("등록되지 않은 티켓입니다", 404);
  }

  const v2TicketId = ticket.ticket_id;
  const ticketNumber = ticket.ticket_number ?? deriveTicketNumber(v2TicketId);
  const attendeeName = ticket.order.buyer?.name ?? "";
  const productName = ticket.product_name ?? "상품";

  // 리스트 상품필터(product_ids = go product UUID) — product_external_ref(= go productId)로 정확매칭.
  if (Array.isArray(list.productIds) && list.productIds.length > 0) {
    if (ticket.product_external_ref == null || !list.productIds.includes(ticket.product_external_ref)) {
      return errorResponse("선택한 체크인 리스트 대상 상품이 아닙니다", 400);
    }
  }

  // F1: 입장 SoT = v2 event_admissions(per-day). '이미 입장' 판정을 여기서 하지 않는다
  // (allpass 2일차가 1일차 status 때문에 거부되던 다일 붕괴 P0 해소). 다만 미확정(대기/취소)
  // 티켓은 사전 차단 유지: checked_in 은 재입장 가능성이 있으므로 통과, 그 외 상태만 가드.
  // W4-ORD: 판정 입력을 go attendees.status → v2 ticket status 투영으로 교체(정본 일치).
  const projectedStatus = (
    ticket.checked_in_at ? "checked_in" : projectToGoAttendeeStatus(ticket.status)
  ) as AttendeeStatus;
  if (projectedStatus !== "checked_in" && !canTransitionAttendee(projectedStatus, "checked_in")) {
    return errorResponse("확정된 참석자만 체크인할 수 있습니다", 400);
  }

  // ── 3) v2 write-through (커머스 SoT). F1: 입장 멱등 SoT=event_admissions. 오늘 재스캔→already:true.
  //    admission_mode·attended_date 는 F1 신규 필드(다일 입장). CANCELLED/EXPIRED·입장일아님 → 422.
  //    ⚠️ go 트랜잭션 **밖**에서 호출한다 — 외부호출을 트랜잭션 안에 두면 v2 왕복 내내 go 락을
  //       잡고 있으면서도 롤백으로 v2 입장을 되돌리지 못한다(원자성 착시). ──
  let v2Result: {
    checked_in_at: string;
    status: string;
    already: boolean;
    outcome?: "admitted" | "reentry_ok";
    admission_mode?: string;
    attended_date?: string;
  };
  try {
    // 🔴 오프라인 동기화는 **현장 실입장 시각**을 v2 에 전달한다(2026-07-28 수정).
    //
    // 종전에는 항상 `new Date()`(=동기화 시각)를 보냈고, `offlineCheckedInAt` 은 go 로그·감사에만
    // 남았다. v2 는 이 시각으로 **입장일(KST)** 을 정하고 daypass 확정일을 박는다.
    // ⟹ 목요일 23:50 오프라인 입장을 금요일 00:10 에 동기화하면 입장일이 **금요일**로 기록돼,
    //    주중권(목·금 중 하루)이 금요일 하루를 새로 얻는다. 다일 대회에서 실제로 재고가 샌다.
    //
    // 신뢰 경계: `offlineCheckedInAt` 은 클라이언트가 준 값이라 임의 과거/미래를 넣을 수 있다.
    // 그래서 **오프라인 동기화 경로에서만**(origin=offline_sync, manual 한정 — 스키마 refine)
    // 채택하고, 그 밖에는 서버 시각을 쓴다.
    //
    // ⚠️ 2026-07-28 정정: 여기 원래 "값의 타당성은 v2 admit() 의 입장일 판정이 최종 게이트"라고
    //    적혀 있었는데 **그 게이트는 존재하지 않았다**. admit() 은 입장'일' 규칙만 보고
    //    "그 시각이 실재하는가"는 판정하지 않는다. 그래서 목요일에 `at=금요일`(미래)을 보내면
    //    daypass 가 금요일로 확정되고 목요일 실입장은 원장에 남지 않아, 주중권 1장으로
    //    **목+금 이틀 입장**이 원장상 깨끗하게 성립했다.
    //    ⟹ v2 `_do_check_in` 에 미래시각 거부(`_CHECKIN_FUTURE_SKEW`)를 신설해 닫았다.
    //    없는 하위 게이트를 근거로 신뢰 경계를 넓히지 말 것 — 이 주석이 그 사례다.
    v2Result = await checkInTicket(v2TicketId, {
      at: offlineAt ?? new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof V2CommerceError) {
      if (err.status >= 400 && err.status < 500) {
        // 🔴 v2 의 거부 사유를 그대로 게이트에 보여준다.
        //
        // 2026-07-28 실측: 여기가 **모든 422 를 "취소/만료" 로 덮어쓰고** 있었다. v2 는
        // 422 로 여러 사유를 구분해 내려보낸다 — "이 등급의 입장 가능일이 아닙니다",
        // "지정된 입장일이 아닙니다", "이미 8/20 에 입장한 티켓입니다(1회 입장권)",
        // 그리고 실제 취소/만료. 이걸 뭉개면 정상 티켓을 든 관객에게 스태프가
        // "취소된 표"라고 말하게 된다 — 현장에서 가장 나쁜 오안내다.
        //
        // v2 메시지는 이미 한국어 관객 문구다(admission_service). 다만 commerce-client 가
        // `CODE: 사유` 로 합쳐 던지므로(commerce-client.ts:156) 코드 접두어를 벗긴다.
        // 벗긴 뒤가 한국어가 아니면(내부 영문 메시지) 게이트에 그대로 노출하지 않고 폴백한다.
        const reason = stripV2ErrorCode(err.message);
        return errorResponse(
          reason ??
            (err.status === 422
              ? "체크인할 수 없는 티켓입니다"
              : "체크인 요청이 거부되었습니다"),
          err.status === 422 ? 400 : err.status,
        );
      }
      logger.error("v2 체크인 write-through 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        status: err.status,
        message: err.message,
      });
      return errorResponse("체크인 처리 중 오류가 발생했습니다", 502);
    }
    throw err;
  }

  const checkedInAt = v2Result.checked_in_at ?? ticket.checked_in_at ?? new Date().toISOString();
  // F1: 입장일(KST). v2 admit 이 attended_date 를 정본으로 계산. 미제공(구 v2)이면 checkedInAt 로 파생.
  const attendedDate = v2Result.attended_date ?? checkedInAt.slice(0, 10);

  // F1: '오늘 이미 입장' 판정은 v2 event_admissions(SoT)에서만 온다(v2Result.already).
  // go-local attendees.status 로 판정하지 않는다 — allpass 2일차는 status='checked_in' 이어도
  // v2Result.already=false 이므로 정상 입장으로 처리돼야 한다.
  // §13 당일 재입장: outcome=reentry_ok(당일 재스캔=정상 재입장, 초록). already 이지만 차단 아님.
  // v2 가 outcome 미제공(구버전)이면 already 로 reentry_ok 파생.
  const outcome: "admitted" | "reentry_ok" = v2Result.already
    ? (v2Result.outcome ?? "reentry_ok")
    : (v2Result.outcome ?? "admitted");

  // W4-ORD: go attendees 는 **write 전용 투영 캐시**로 강등됐다. 발송 세그먼트
  // (lib/notification/recipients.ts)가 `attendees.status='checked_in'` 로 대상을 고르므로
  // v2 입장 성공 후 동기화한다. 키는 v2_ticket_id — go-native id 를 더 이상 읽지 않기 때문.
  // 행이 없으면 0행 UPDATE(무해): 정본은 v2 이고 이 행은 발송 필터용 사본일 뿐이다.
  //
  // W5-ATTENDEE: 이제 go write 가 이 **단일 문장 하나**라 명시적 BEGIN/COMMIT 이 없다
  // (단문은 그 자체로 원자적). 옛 트랜잭션은 `check_in_logs` INSERT 와 묶기 위한 것이었고,
  // 그 로그는 v2 로 옮겨졌다. 오히려 v2 왕복을 go 트랜잭션 안에 두지 않게 되어 좋다.
  await pool.query(
    `
      UPDATE attendees
      SET status = 'checked_in', checked_in_at = $3, updated_at = NOW()
      WHERE account_id = $1 AND v2_ticket_id = $2::uuid
    `,
    [session.accountId, v2TicketId, checkedInAt],
  );

  // ── 현장 체크인 로그 (W5-ATTENDEE: v2 정본, 멱등) ──
  //
  // UNIQUE(ticket_id, attended_date) 덕분에 이 기록은 **재시도 가능한 멱등 연산**이다.
  // 그래서 `already`(재스캔) 경로에서도 시도한다 — 앞선 스캔에서 입장은 성공했는데 로그만
  // 실패한 경우 이 재스캔이 **복구**한다(이미 있으면 created=false, 중복 행 불가).
  //
  // 🔴 실패 정책(제품 판단): 로그 기록 실패로 **관람객을 막지 않는다**. 입장의 정본은 이미
  //    커밋된 v2 `event_admissions` 이고, 여기서 502 를 주면 정당한 입장이 게이트에서
  //    거부된 것처럼 보인다. 대신 `logRecorded:false` 로 **사실을 숨기지 않고** 전달하고
  //    (UI 가 경고 표시), logger.error 로 운영 알림을 남기며, 재스캔이 자동 복구한다.
  let logRecorded = true;
  try {
    await recordCheckInLog(params.eventId, session.accountId, {
      ticket_id: v2TicketId,
      attended_date: attendedDate,
      check_in_list_id: body.checkInListId,
      attendee_name: attendeeName,
      ticket_number: ticketNumber,
      checked_in_by_ref: session.id,
      method: isOffline ? "offline" : isManual ? "manual" : "qr",
    });
  } catch (err: unknown) {
    logRecorded = false;
    logger.error("체크인 로그 기록 실패(입장은 확정됨 — 재스캔 시 복구)", {
      eventId: params.eventId,
      ticketId: v2TicketId,
      attendedDate,
      status: err instanceof V2CommerceError ? err.status : undefined,
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  if (v2Result.already) {
    return successResponse({
      alreadyCheckedIn: true,
      reentryOk: true,
      outcome,
      logRecorded,
      attendee: {
        id: v2TicketId,
        name: attendeeName,
        ticketNumber,
        product: productName,
        checkedInAt,
        admissionMode: v2Result.admission_mode ?? null,
        attendedDate,
      },
    });
  }

  // 수동·오프라인 체크인은 의도적 스태프 액션 → 감사로그. 스캔은 check_in_logs 로 이미 추적.
  // 오프라인은 회전 QR 미검증(캡처방지 무력) 명시 — mode="offline", 현장 실입장 시각 보존.
  if (isManual) {
    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "check_in",
      tableName: "tickets",
      recordId: v2TicketId,
      changes: isOffline
        ? {
            mode: "offline",
            qrVerified: false,
            reason: body.manualReason ?? "오프라인 육안 대조",
            ticketNumber,
            attendedDate,
            offlineCheckedInAt: offlineAt,
          }
        : { mode: "manual", reason: body.manualReason ?? null, ticketNumber, attendedDate },
    }).catch((err: unknown) => {
      logger.warn("수동 체크인 감사로그 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        error: err instanceof Error ? err.message : "unknown",
      });
    });
  }

  // F2: 초대권 추적 원장 checked_in 전이(best-effort). 초대권 아닌 티켓은 무매칭.
  await markInvitationCheckedIn(ticketNumber);

  await dispatchWebhook("attendee.checked_in", {
    eventId: params.eventId,
    attendeeId: v2TicketId,
    ticketNumber,
    name: attendeeName,
    productName,
    attendedDate,
  }).catch((err: Error) => {
    logger.warn("체크인 webhook dispatch 실패", {
      eventId: params.eventId,
      ticketId: v2TicketId,
      error: err.message,
    });
  });

  return successResponse({
    outcome, // §13: admitted (초록 신규입장)
    logRecorded,
    attendee: {
      id: v2TicketId,
      name: attendeeName,
      ticketNumber,
      product: productName,
      checkedInAt,
      admissionMode: v2Result.admission_mode ?? null,
      attendedDate,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 체크인 undo/취소 (오스캔 복구) — 스태프 권한·사유 필수.
// v2 입장 원장(event_admissions)을 취소(정본) → go check_in_logs/발송캐시 정합 원복.
// 멱등: v2 revoked:false 여도 go 캐시는 안전하게 정리(v2 가 취소의 SoT·멱등 주체).
// W4-ORD: attendeeId = **v2 ticket_id**(체크인 응답·최근로그 위젯이 주는 값과 동일 키).
//   옛 go attendees FOR UPDATE 락은 폐기 — 취소 멱등의 정본도 v2 원장이다.
// ─────────────────────────────────────────────────────────────────────────────
const revokeSchema = z.object({
  attendeeId: z.string().uuid(),
  // 취소 대상 입장일(KST YYYY-MM-DD). 미제공 시 v2 가 today(KST) 기준.
  attendedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "attendedDate 는 YYYY-MM-DD 형식이어야 합니다")
    .optional(),
  reason: z.string().min(1, "취소 사유를 입력해주세요").max(200),
});

export const DELETE = withRole<Params>("staff", async (request, { session, params }) => {
  const parsed = await parseBody(revokeSchema, request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const pool = getPool();

  // ── 1) 티켓 해석·소유검증 (v2). 🔴 v2 장애를 "등록되지 않은 참석자(404)" 로 위장하지 않는다.
  //    404 로 흘리면 UI 는 "이미 취소됨"으로 읽고 스태프는 취소가 된 줄 안다 → 503 으로 끊는다. ──
  let ticket: TicketDetail | null;
  try {
    ticket = await resolveOwnedTicket(body.attendeeId, params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof TicketAccessError) {
      return errorResponse("티켓 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
  if (!ticket) {
    return errorResponse("등록되지 않은 참석자입니다", 404);
  }

  const v2TicketId = ticket.ticket_id;
  const ticketNumber = ticket.ticket_number ?? deriveTicketNumber(v2TicketId);
  const attendeeName = ticket.order.buyer?.name ?? "";
  const priorStatus = (
    ticket.checked_in_at ? "checked_in" : projectToGoAttendeeStatus(ticket.status)
  ) as AttendeeStatus;

  // ── 2) v2 입장 취소(SoT) — go 트랜잭션 밖. 실패하면 go 를 아예 건드리지 않는다. ──
  let v2Revoke: { revoked: boolean; attended_date: string; was_last_admission: boolean };
  try {
    v2Revoke = await revokeAdmission(v2TicketId, {
      attended_date: body.attendedDate,
      reason: body.reason,
    });
  } catch (err) {
    if (err instanceof V2CommerceError) {
      if (err.status >= 400 && err.status < 500) {
        return errorResponse("입장 취소 요청이 거부되었습니다", err.status);
      }
      logger.error("v2 입장취소 write-through 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        status: err.status,
        message: err.message,
      });
      return errorResponse("입장 취소 처리 중 오류가 발생했습니다", 502);
    }
    throw err;
  }

  try {
    // 발송 세그먼트 캐시 원복 — v2 가 이 입장을 이 티켓의 **마지막 입장**으로 취소한 경우에만
    // 'confirmed' 로 되돌린다(다일 잔여 입장이 있으면 checked_in 유지). was_last_admission 이 SoT.
    if (v2Revoke.was_last_admission) {
      await pool.query(
        `
          UPDATE attendees
          SET status = 'confirmed', checked_in_at = NULL, updated_at = NOW()
          WHERE account_id = $1 AND v2_ticket_id = $2::uuid
        `,
        [session.accountId, v2TicketId],
      );
    }

    // 해당 입장일의 체크인 로그 원복(집계 정합) — W5-ATTENDEE: v2 정본.
    //
    // 🔴 실패를 삼키지 않는다. 입장은 v2 에서 취소됐는데 로그가 남으면 집계·CSV 가 입장자를
    //    과다 계상한다. 502 로 알려 **운영자가 재시도**하게 한다 — 취소는 저빈도 의도 액션이고,
    //    v2 revoke 는 멱등(이미 취소면 revoked:false)이라 재시도가 안전하게 수렴한다.
    //    (게이트 통과와 달리 여기서는 재시도 요구가 관람객을 막지 않는다.)
    await deleteCheckInLogs(params.eventId, session.accountId, {
      ticketId: v2TicketId,
      attendedDate: v2Revoke.attended_date,
    });

    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "check_in",
      tableName: "tickets",
      recordId: v2TicketId,
      changes: {
        op: "revoke_admission",
        reason: body.reason,
        attendedDate: v2Revoke.attended_date,
        revoked: v2Revoke.revoked,
        wasLastAdmission: v2Revoke.was_last_admission,
        ticketNumber,
      },
    }).catch((err: unknown) => {
      logger.warn("입장취소 감사로그 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        error: err instanceof Error ? err.message : "unknown",
      });
    });

    await dispatchWebhook("attendee.admission_revoked", {
      eventId: params.eventId,
      attendeeId: v2TicketId,
      ticketNumber,
      name: attendeeName,
      attendedDate: v2Revoke.attended_date,
      wasLastAdmission: v2Revoke.was_last_admission,
    }).catch((err: Error) => {
      logger.warn("입장취소 webhook dispatch 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        error: err.message,
      });
    });

    return successResponse({
      revoked: v2Revoke.revoked,
      wasLastAdmission: v2Revoke.was_last_admission,
      attendee: {
        id: v2TicketId,
        name: attendeeName,
        ticketNumber,
        status: v2Revoke.was_last_admission ? "confirmed" : priorStatus,
        attendedDate: v2Revoke.attended_date,
      },
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      logger.error("입장취소 체크인 로그 원복 실패", {
        eventId: params.eventId,
        ticketId: v2TicketId,
        attendedDate: v2Revoke.attended_date,
        status: err.status,
      });
      return errorResponse(
        "입장은 취소됐지만 현장 기록 정리에 실패했습니다. 잠시 후 다시 취소를 눌러주세요.",
        502,
      );
    }
    throw err;
  }
});
