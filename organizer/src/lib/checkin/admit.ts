/**
 * 입장 판정·기록 — **대시보드와 현장업체 API 가 공유하는 단 하나의 경로**.
 *
 * 두 벌로 두면 다음에 한쪽만 고쳐진다. 이 리포에서 실제로 그렇게 죽은 코드가 여럿이다.
 *
 * ## 무엇을 하고 무엇을 안 하는가
 *
 * ```
 * 한다     회전 QR 검증 · 티켓 해석(행사 경계) · v2 입장 기록 · 결과 번역
 * 안 한다  🔴 **입장 자격 판정을 새로 만들지 않는다.**
 *          취소·만료·입장일·중복·재입장은 전부 v2 `admit()` 한 곳이 정본이다.
 *          여기서는 그 결과를 옮길 뿐이다 — 규칙이 두 벌이 되면 게이트에서 갈린다.
 * ```
 *
 * ## 🔴 원장 기록이 목적이다
 *
 * v2 `event_admissions` 에 남아야 손님 티켓 화면이 바뀐다(`admitted_today`).
 * 업체가 자기 시스템에만 기록하면 손님 화면엔 QR 이 계속 뜬다.
 */
import {
  clampToleranceWindows,
  dynamicQRSignatureValid,
  verifyDynamicQRPayload,
} from "@/lib/ticket/dynamic-qr";
import { checkInTicket, V2CommerceError } from "@/lib/v2/commerce-client";
import { v2ErrorDetails } from "@/lib/v2/error-code";
import type { TicketDetail } from "@/lib/v2/commerce-client";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { resolveOwnedTicketByNumber, TicketAccessError } from "@/lib/v2/ticket-access";

/** 입장 성공 종류. 🔴 둘을 뭉치면 재입장에 기념품이 두 번 나간다. */
export type AdmitOutcome = "admitted" | "reentry_ok";

/**
 * 거부 사유 — 업체가 **분기에 쓰는 값**.
 *
 * `unavailable` 은 우리 장애다(업체는 현장 판단으로 통과시키고 큐에 쌓는다).
 */
export type AdmitReject =
  | "invalid"
  | "expired_qr"
  | "not_admission_day"
  | "cancelled"
  | "not_found"
  | "unavailable";

export type ScanResolve =
  | { ok: true; ticketNumber: string }
  | { ok: false; reason: "invalid" | "expired_qr"; message: string };

/**
 * 🔴 **참석자 본인** 신원 — 구매자가 아니다.
 *
 * 3장을 사서 지인에게 나눠주면 v2 `order.buyer` 는 셋 다 구매자다. 게이트에서
 * "홍길동님 맞으시죠?" 가 다른 사람 이름이 된다. 초대권은 아예 수신자가 따로다.
 */
export interface AdmitHolder {
  /** 값이 없으면 **빈 문자열**(null 아님) — 업체 파싱을 단순하게. */
  name: string;
  /** 🔴 하이픈 없는 숫자열(`01012345678`). 우리 원장 저장형과 같다. */
  phone: string;
}

export type AdmitResult =
  | {
      ok: true;
      outcome: AdmitOutcome;
      ticket: TicketDetail;
      holder: AdmitHolder;
      checkedInAt: string;
      attendedDate: string;
    }
  | { ok: false; reason: AdmitReject; message: string; status: number };

/**
 * 회전 QR 페이로드에서 티켓번호를 꺼낸다.
 *
 * ⚠️ 비-PKT(정적 QR·임의 문자열)는 **폴백하지 않고 거부**한다. 자동 폴백은 스캐너가
 *    임의 문자열을 티켓번호로 통과시키던 보안구멍이었다.
 *
 * ⚠️ 서명 실패와 시간창 초과를 **구분해 돌려준다**. 업체 화면에서 "위조" 와 "다시 스캔
 *    해주세요" 는 완전히 다른 안내다.
 */
export function resolveScanPayload(payload: string, toleranceWindows?: number): ScanResolve {
  if (!payload.startsWith("PKT:")) {
    return {
      ok: false,
      reason: "invalid",
      message: "회전 QR이 아닙니다. 화면의 회전 QR을 다시 제시해주세요.",
    };
  }
  const tolerance = clampToleranceWindows(toleranceWindows);
  const { valid, ticketId } = verifyDynamicQRPayload(payload, tolerance);
  if (valid && ticketId) return { ok: true, ticketNumber: ticketId };

  // 🔴 **서명만** 따로 본다. 서명이 맞는데 떨어졌다면 원인은 **시간**이다.
  //    넓은 허용창으로 재검증하는 방법은 안 된다 — 허용창 상한(20창 ≈ 20분)을 넘긴
  //    정상 QR 이 여전히 "위조" 로 보고된다. 골프장에서 화면을 오래 켜 둔 손님이 그 경우다.
  if (dynamicQRSignatureValid(payload)) {
    return {
      ok: false,
      reason: "expired_qr",
      message: "QR이 만료되었습니다. 화면을 새로고침한 뒤 다시 스캔해주세요.",
    };
  }
  return {
    ok: false,
    reason: "invalid",
    message: "유효하지 않은 QR입니다. 화면의 회전 QR을 다시 제시해주세요.",
  };
}

/**
 * 🔴 v2 거부 문구 → 업체가 분기할 사유.
 *
 * ✅ 2026-08-10 — v2 가 `error.details.admission_code` 를 실어 보낸다. **코드로 가른다.**
 *
 * ⚠️ 문구 표는 **폴백으로 남긴다.** 구버전 v2(배포 순서가 어긋난 순간)에서는 코드가
 *    안 오는데, 그때 현장이 멈추면 안 된다. 폴백을 지우면 전건 오분류된다.
 */
/**
 * 🔴 **1순위 — v2 가 준 코드**로 가른다 (2026-08-10 v2 개선 반영).
 *
 * `AdmissionError.code` 가 `error.details.admission_code` 로 온다.
 * ⚠️ 구버전 v2 는 안 준다 — 그때는 아래 문구 폴백으로 내려간다.
 *    **배포 순서가 어긋나도 현장이 멈추면 안 된다**(go 가 먼저 올라갈 수 있다).
 */
const REJECT_BY_ADMISSION_CODE: Readonly<Record<string, AdmitReject>> = {
  NOT_ADMITTABLE: "cancelled",
  NOT_ADMISSION_DAY: "not_admission_day",
  TIER_ADMISSION_DAYS_INVALID: "not_admission_day",
};

/** 🔴 폴백 — 구버전 v2 용. 코드가 오면 이 표는 안 쓴다. */
const REJECT_BY_MESSAGE: ReadonlyArray<readonly [RegExp, AdmitReject]> = [
  [/취소|만료/, "cancelled"],
  [/입장 가능일|입장일/, "not_admission_day"],
  [/이미.*입장한 티켓/, "not_admission_day"],
];

export function classifyAdmitReject(
  message: string,
  admissionCode?: string | null,
): AdmitReject {
  // 🔴 코드가 있으면 그것이 정본. 문구는 보지 않는다.
  if (admissionCode) {
    const byCode = REJECT_BY_ADMISSION_CODE[admissionCode];
    if (byCode) return byCode;
  }
  for (const [re, reason] of REJECT_BY_MESSAGE) {
    if (re.test(message)) return reason;
  }
  // 🔴 모르면 **입장 불가 쪽**으로 답한다. "유효하지 않은 QR"(invalid)로 답하면
  //    멀쩡한 표를 든 손님이 위조범으로 보인다 — 현장에서 가장 나쁜 오안내다.
  return "cancelled";
}

/** `commerce-client` 가 붙인 `CODE: 사유` 접두어를 벗긴다. 한국어가 아니면 버린다. */
export function stripV2Message(raw: string): string | null {
  const idx = raw.indexOf(": ");
  const body = idx > 0 && idx < 40 ? raw.slice(idx + 2) : raw;
  return /[가-힣]/.test(body) ? body.trim() : null;
}

/** 하이픈·공백을 벗긴 숫자열. `lib/server/invitations.ts` 의 정규화와 같은 규칙이다. */
function digitsOnly(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/**
 * 🔴 참석자 본인 이름·전화 — **go `attendees` 가 1순위**.
 *
 * ```
 * 1순위  go attendees.name / .phone     초대권·수동발권은 **수신자**가 들어 있다
 * 2순위  v2 order.buyer                 유료 경로는 attendees 도 구매자라 사실상 같다
 * 3순위  빈 문자열
 * ```
 *
 * ⚠️ v2 `TicketDetail` 에는 전화번호가 없다. v2 를 고치지 않고 go 자체 원장을 읽는다.
 *
 * ⚠️ 실패해도 **입장을 막지 않는다.** 신원은 부가 정보이고, 이걸 못 읽었다고 게이트에서
 *    사람을 세우면 안 된다 — 폴백으로 내려간다.
 */
async function resolveHolder(
  accountId: string,
  ticketNumber: string,
  ticket: TicketDetail,
): Promise<AdmitHolder> {
  const buyerName = ticket.order.buyer?.name ?? "";
  const buyerPhone = digitsOnly(ticket.order.buyer?.phone);
  try {
    const res = await getPool().query<{ name: string | null; phone: string | null }>(
      `SELECT name, phone FROM attendees
       WHERE account_id = $1 AND ticket_number = $2
       LIMIT 1`,
      [accountId, ticketNumber],
    );
    const row = res.rows[0];
    if (row) {
      return {
        name: (row.name ?? "").trim() || buyerName,
        phone: digitsOnly(row.phone) || buyerPhone,
      };
    }
  } catch (err: unknown) {
    logger.warn("현장 신원 조회 실패 — 구매자 정보로 폴백", {
      ticketNumber,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  return { name: buyerName, phone: buyerPhone };
}

export interface AdmitInput {
  eventId: string;
  accountId: string;
  ticketNumber: string;
  /** 실제 입장 시각(ISO). 오프라인 큐 전송이면 **현장 시각**을 준다. */
  at?: string | null;
}

/**
 * 티켓을 해석하고 v2 원장에 입장을 기록한다.
 *
 * 🔴 실패를 위장하지 않는다:
 *   · v2 조회 실패 → `unavailable`(503). "등록되지 않은 티켓"(404)로 뭉개면 게이트에서
 *     "이 사람 표가 가짜다" 로 읽힌다.
 *   · v2 4xx 거부 → 사유를 그대로 옮긴다. 전부 "취소/만료" 로 덮으면 정상 티켓 손님에게
 *     스태프가 "취소된 표" 라고 말하게 된다(2026-07-28 실측 결함).
 */
export async function admitTicketByNumber(input: AdmitInput): Promise<AdmitResult> {
  let ticket: TicketDetail | null;
  try {
    ticket = await resolveOwnedTicketByNumber(input.ticketNumber, input.eventId, input.accountId);
  } catch (err: unknown) {
    if (err instanceof TicketAccessError) {
      return {
        ok: false,
        reason: "unavailable",
        message: "티켓 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
        status: 503,
      };
    }
    throw err;
  }
  if (!ticket) {
    // 🔴 다른 행사 티켓도 여기로 온다(`resolveOwnedTicketByNumber` 가 경계를 본다).
    return { ok: false, reason: "not_found", message: "등록되지 않은 티켓입니다", status: 404 };
  }

  let v2Result: {
    checked_in_at: string;
    status: string;
    already: boolean;
    outcome?: AdmitOutcome;
    attended_date?: string;
  };
  try {
    // 🔴 `at` 은 **현장 실입장 시각**이다. 오프라인 큐가 몇 시간 뒤 올라와도 그 시각으로
    //    기록해야 입장일(KST)이 맞는다. 목요일 23:50 입장을 금요일에 동기화하면서
    //    동기화 시각을 보내면 주중권이 금요일 하루를 새로 얻는다.
    //    미래 시각은 v2 가 거부한다(_CHECKIN_FUTURE_SKEW).
    v2Result = await checkInTicket(ticket.ticket_id, { at: input.at ?? new Date().toISOString() });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status >= 400 && err.status < 500) {
        const message = stripV2Message(err.message);
        // 🔴 **상태코드로 가른다** — 문구가 아니다.
        //    v2 는 입력 오류를 400(`VALIDATION_ERROR`, 예: 미래 시각), 입장 자격 거부를
        //    422(`STATE_TRANSITION_FORBIDDEN`)로 낸다. 구조가 이미 다르므로 그것을 쓴다.
        //    미래 시각 거부는 **이틀 입장 우회를 막는 자리**라 사유를 뭉개면 안 된다.
        if (err.status !== 422) {
          return {
            ok: false,
            reason: "invalid",
            message: message ?? "입장 요청이 올바르지 않습니다",
            status: 400,
          };
        }
        const admissionCode = v2ErrorDetails(err)?.admission_code;
        return {
          ok: false,
          reason: classifyAdmitReject(
            message ?? "",
            typeof admissionCode === "string" ? admissionCode : null,
          ),
          message: message ?? "입장할 수 없는 티켓입니다",
          status: 403,
        };
      }
      logger.error("v2 입장 기록 실패", {
        eventId: input.eventId,
        ticketNumber: input.ticketNumber,
        status: err.status,
      });
      return {
        ok: false,
        reason: "unavailable",
        message: "입장 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        status: 502,
      };
    }
    throw err;
  }

  const checkedInAt =
    v2Result.checked_in_at ?? ticket.checked_in_at ?? new Date().toISOString();
  const attendedDate = v2Result.attended_date ?? checkedInAt.slice(0, 10);
  // 🔴 v2 가 outcome 을 주면 그것이 정본. 구버전이면 `already` 로 파생한다.
  const outcome: AdmitOutcome = v2Result.already
    ? (v2Result.outcome ?? "reentry_ok")
    : (v2Result.outcome ?? "admitted");

  const holder = await resolveHolder(input.accountId, input.ticketNumber, ticket);
  return { ok: true, outcome, ticket, holder, checkedInAt, attendedDate };
}
