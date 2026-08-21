/**
 * POST /api/onsite/checkin — 현장 입장업체 전용 (🔴 이 대회 1회용)
 *
 * 현장 입장은 외부 전문업체가 자기 스캐너로 진행한다. 업체가 우리 QR 을 읽어 원본 그대로
 * 보내면 우리가 판정·기록하고 결과를 돌려준다.
 *
 * ```
 * 손님 QR ─스캔─▶ 업체 시스템 ─HTTP─▶ 여기
 *                                     ├ 서명·시각 검증   (lib/checkin/admit)
 *                                     ├ 입장 자격 판정   (v2 admit 이 정본)
 *                                     ├ 🔴 원장 기록     (있어야 손님 화면의 QR 이 사라진다)
 *                                     └ 이름·등급·경품번호 응답
 * ```
 *
 * ## 🔴 대회 후 걷어낸다
 *
 * 파트너 관리체계(`partners.py`)를 쓰지 않는다. **BC카드·한경 KLPGA 1회용**이다.
 * 대회가 끝나면 `ONSITE_CHECKIN_KEY` 를 지우고 이 파일을 삭제한다.
 * ⚠️ 키가 없으면 이 라우트는 **항상 503** 이다 — 켜는 것 자체가 명시적 행위여야 한다.
 *
 * ## 🔴 경로 자체가 권한이다
 *
 * 조직자 세션·내부 서비스 토큰을 재사용하지 않는다. 그건 업체에게 우리 내부 신뢰 경계를
 * 통째로 주는 것이다. 전용 키 + **이벤트 고정**만 준다.
 */
import { timingSafeEqual } from "node:crypto";

import { withRateLimit } from "@/lib/auth/withRateLimit";
import { admitTicketByNumber, resolveScanPayload } from "@/lib/checkin/admit";
import { logger } from "@/lib/logger";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

/** 업체가 분기에 쓰는 값. `admitted` 와 `reentry_ok` 를 **반드시 구분**해 내보낸다. */
interface OnsiteOk {
  result: "admitted" | "reentry_ok";
  ticket_no: string;
  holder_name: string;
  /** 🔴 하이픈 없는 숫자열(`01012345678`). 값이 없으면 빈 문자열. */
  holder_phone: string;
  tier: string;
  raffle_no: number | null;
  attended_date: string;
}

/**
 * 🔴 개인정보 — 전화번호는 유출 시 파장이 이름과 다르다.
 *
 * 업체 스캐너 로그가 그대로 **관람객 연락처 명단**이 된다. 그래서:
 *   · 로그에 전화번호를 남기지 않는다 (아래 logger 호출들이 그 원칙이다)
 *   · **입장한 사람에게만** 나간다 — 거부 응답(403/400/401)에는 넣지 않는다
 *     (거부에도 실으면 QR 을 무작위로 던져 번호를 긁어낼 수 있다)
 */

function keyMatches(provided: string): boolean {
  const expected = process.env.ONSITE_CHECKIN_KEY ?? "";
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual 은 길이가 다르면 던진다 — 길이 자체도 비밀은 아니므로 먼저 거른다.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 🔴 업체 응답은 **평평한 본문**이다.
 *
 * 우리 내부 라우트는 `{success, data}` 봉투를 쓰지만, 업체 명세서는 최상위에
 * `result` 가 오는 모양이다. 봉투를 씌우면 업체가 `data.result` 를 읽어야 하고,
 * 명세서와 실제가 어긋난 채 대회 당일을 맞는다. 여기서만 봉투를 벗긴다.
 */
function reject(reason: string, message: string, status: number) {
  return Response.json({ result: "rejected", reason, message }, { status });
}

/** 우리 장애·설정 오류 — 업체 규약상 "현장 판단으로 통과 + 큐 적재" 대상. */
function serverSide(message: string, status: number) {
  return Response.json({ result: "error", message }, { status });
}

async function onsiteCheckinHandler(request: Request) {
  const expected = process.env.ONSITE_CHECKIN_KEY ?? "";
  const eventId = process.env.ONSITE_CHECKIN_EVENT_ID ?? "";
  if (!expected || !eventId) {
    // 🔴 설정이 없으면 **닫혀 있다**. 키 없이 열리는 경로를 만들지 않는다.
    logger.warn("현장 입장 API 미설정 — 요청 거부", {
      hasKey: Boolean(expected),
      hasEvent: Boolean(eventId),
    });
    return serverSide("현장 입장 API가 활성화되지 않았습니다", 503);
  }
  if (!keyMatches(request.headers.get("x-onsite-key") ?? "")) {
    return Response.json({ result: "rejected", reason: "unauthorized", message: "인증에 실패했습니다" }, { status: 401 });
  }

  let body: { qr?: unknown; scanned_at?: unknown; device_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reject("invalid", "요청 본문이 올바른 JSON이 아닙니다.", 400);
  }
  const qr = typeof body.qr === "string" ? body.qr : "";
  const scannedAt = typeof body.scanned_at === "string" ? body.scanned_at : null;
  const deviceId = typeof body.device_id === "string" ? body.device_id.slice(0, 64) : null;
  if (!qr) {
    return reject("invalid", "QR 값이 비어 있습니다.", 400);
  }
  if (scannedAt !== null && Number.isNaN(Date.parse(scannedAt))) {
    return reject("invalid", "스캔 시각 형식이 올바르지 않습니다.", 400);
  }

  // 🔴 서명·시간창 — 공통 함수. 대시보드 스캔 경로와 **같은 규칙**이다.
  const scan = resolveScanPayload(qr);
  if (!scan.ok) {
    return reject(scan.reason, scan.message, 403);
  }

  // 🔴 이벤트 고정 — 키가 이 행사에만 유효하다. 티켓 소유 경계는 event + account 로 본다.
  //    account 는 env 로 또 받지 않고 **행사에서 끌어온다**(둘이 어긋날 여지를 없앤다).
  const resolved = await resolvePublicEventById(eventId, PUBLIC_ANY_STATUS);
  if (!resolved.ok || !resolved.event.go_account_id) {
    logger.error("현장 입장 API — 고정 행사 해석 실패", { eventId });
    return serverSide("행사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
  }

  const admitted = await admitTicketByNumber({
    eventId,
    accountId: resolved.event.go_account_id,
    ticketNumber: scan.ticketNumber,
    // 🔴 업체가 준 **현장 시각**으로 기록한다. 오프라인 큐가 몇 시간 뒤 올라와도
    //    입장일(KST)이 맞아야 한다. 미래 시각은 v2 가 거부한다.
    at: scannedAt,
  });

  if (!admitted.ok) {
    if (admitted.reason === "unavailable") {
      // 🔴 우리 장애다. 업체 규약: 5xx 면 현장 판단으로 통과시키고 큐에 쌓는다.
      return serverSide(admitted.message, admitted.status);
    }
    logger.info("현장 입장 거부", {
      eventId, deviceId, reason: admitted.reason, ticketNumber: scan.ticketNumber,
    });
    return reject(admitted.reason, admitted.message, admitted.status === 404 ? 403 : admitted.status);
  }

  const t = admitted.ticket;
  const payload: OnsiteOk = {
    result: admitted.outcome,
    ticket_no: t.ticket_number ?? scan.ticketNumber,
    // 🔴 **참석자 본인**이다(구매자 아님). 3장을 사서 나눠주면 구매자 이름이 셋 다 뜬다.
    holder_name: admitted.holder.name,
    // 🔴 하이픈 없는 숫자열. 명세서에 그렇게 못박는다 — 안 정하면 업체가 추측한다.
    holder_phone: admitted.holder.phone,
    tier: t.product_name ?? "",
    raffle_no: t.raffle_number ?? null,
    attended_date: admitted.attendedDate,
  };
  logger.info("현장 입장", {
    eventId, deviceId, result: payload.result, ticketNumber: payload.ticket_no,
  });
  return Response.json(payload, { status: 200 });
}

export const POST = withRateLimit({
  // 게이트 여러 대가 동시에 들어온다. 상한은 넉넉히 두되 무제한은 아니다.
  max: 600,
  windowMs: 60_000,
  keyPrefix: "onsite:checkin",
})(onsiteCheckinHandler);
