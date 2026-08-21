import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 입장 판정·기록 공통 함수 — **대시보드와 현장업체 API 가 공유**한다.
 *
 * 🔴 여기서 지키는 것:
 *   ① 서명 실패와 시간창 초과를 **구분**한다 (위조 vs 다시 스캔)
 *   ② `admitted` 와 `reentry_ok` 를 **구분**한다 (뭉치면 기념품이 두 번 나간다)
 *   ③ 실패를 위장하지 않는다 (조회 실패를 "가짜 표" 로 만들지 않는다)
 *   ④ 🔴 v2 거부 문구 → 사유 매핑이 **깨지면 알도록** 문구를 못박는다
 */

// env.server 는 server-only 가드가 있어 vitest node 환경에서 직접 import 불가 → 시크릿 고정 스텁.
// (dynamic-qr.test.ts 와 같은 선례)
vi.mock("@/lib/env.server", () => ({
  getRuntimeSecret: (_key: string, fallback: string) => fallback,
}));

const h = vi.hoisted(() => ({
  checkInTicket: vi.fn(),
  resolveOwnedTicketByNumber: vi.fn(),
  class_V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number, readonly body?: string) {
      super(message);
      this.name = "V2CommerceError";
    }
  },
  class_TicketAccessError: class TicketAccessError extends Error {},
  poolQuery: vi.fn(),
}));

vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));

vi.mock("@/lib/v2/commerce-client", async (orig) => {
  const actual = await orig<typeof import("@/lib/v2/commerce-client")>();
  return {
    ...actual,
    checkInTicket: (...a: unknown[]) => h.checkInTicket(...a),
    V2CommerceError: h.class_V2CommerceError,
  };
});
vi.mock("@/lib/v2/ticket-access", () => ({
  resolveOwnedTicketByNumber: (...a: unknown[]) => h.resolveOwnedTicketByNumber(...a),
  TicketAccessError: h.class_TicketAccessError,
}));

import {
  admitTicketByNumber,
  classifyAdmitReject,
  resolveScanPayload,
} from "@/lib/checkin/admit";
import { generateDynamicQRPayload } from "@/lib/ticket/dynamic-qr";

const TICKET_NO = "TKT-DD5FA0740664";
const EVENT = "11111111-1111-1111-1111-111111111111";
const ACCT = "acct-klpga";

function ticketDetail(over: Record<string, unknown> = {}) {
  return {
    ticket_id: "22222222-2222-2222-2222-222222222222",
    ticket_number: TICKET_NO,
    status: "active",
    checked_in_at: null,
    raffle_number: 77,
    product_name: "주중권",
    product_external_ref: "prod-1",
    order: { buyer: { name: "구매자김", email: null, phone: "010-9999-8888" } },
    event: {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveOwnedTicketByNumber.mockResolvedValue(ticketDetail());
  h.poolQuery.mockResolvedValue({ rows: [] });
  h.checkInTicket.mockResolvedValue({
    checked_in_at: "2026-08-20T01:00:00Z", status: "used",
    already: false, outcome: "admitted", attended_date: "2026-08-20",
  });
});
afterEach(() => vi.useRealTimers());

describe("🔴 회전 QR 해석 — 서명 실패와 만료를 구분한다", () => {
  it("유효한 QR 은 티켓번호를 준다", () => {
    const r = resolveScanPayload(generateDynamicQRPayload(TICKET_NO));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticketNumber).toBe(TICKET_NO);
  });

  it("🔴 1비트만 위조해도 invalid — 통과하면 안 된다", () => {
    const good = generateDynamicQRPayload(TICKET_NO);
    const parts = good.split(":");
    const sig = parts[3]!;
    // 마지막 글자만 바꾼다(길이·형식은 그대로 = 형식 검사로는 못 잡는 위조)
    parts[3] = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    const r = resolveScanPayload(parts.join(":"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  it("PKT 접두가 아니면 invalid — 정적 QR 로 폴백하지 않는다", () => {
    const r = resolveScanPayload(TICKET_NO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  it("🔴 허용창 밖은 **expired_qr** — 위조(invalid)와 다르다", () => {
    // 서명은 맞고 시각만 오래된 QR: 30분 전에 만든 것
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00+09:00"));
    const old = generateDynamicQRPayload(TICKET_NO);
    vi.setSystemTime(new Date("2026-08-20T00:30:00+09:00"));
    const r = resolveScanPayload(old);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason, "만료된 정상 QR 이 '위조' 로 보고되면 손님이 의심받는다").toBe("expired_qr");
      expect(r.message).toContain("만료");
    }
  });

  it("허용창 안이면 통과 (경계 반대쪽)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00+09:00"));
    const p = generateDynamicQRPayload(TICKET_NO);
    vi.setSystemTime(new Date("2026-08-20T00:01:00+09:00")); // 60초 = 2창
    expect(resolveScanPayload(p).ok).toBe(true);
  });
});

describe("🔴 admitted / reentry_ok 를 구분한다", () => {
  it("첫 입장은 admitted", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T01:00:00Z", status: "used",
      already: false, outcome: "admitted", attended_date: "2026-08-20",
    });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome).toBe("admitted");
  });

  it("🔴 같은 날 두 번째는 reentry_ok — 거부가 아니다", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T01:00:00Z", status: "used",
      already: true, outcome: "reentry_ok", attended_date: "2026-08-20",
    });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok, "재입장을 거부로 만들면 점심 후 손님이 못 들어온다").toBe(true);
    if (r.ok) expect(r.outcome).toBe("reentry_ok");
  });

  it("v2 가 outcome 을 안 주면(구버전) already 로 파생한다", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T01:00:00Z", status: "used", already: true,
    });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (r.ok) expect(r.outcome).toBe("reentry_ok");
  });
});

describe("🔴 실패를 위장하지 않는다", () => {
  it("v2 조회 장애 → unavailable(503). '등록되지 않은 티켓' 으로 뭉개지 않는다", async () => {
    h.resolveOwnedTicketByNumber.mockRejectedValue(new h.class_TicketAccessError("v2 장애"));
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason, "게이트에서 404 는 '이 사람 표가 가짜다' 로 읽힌다").toBe("unavailable");
      expect(r.status).toBe(503);
    }
  });

  it("🔴 다른 행사 티켓 → not_found (경계는 resolveOwnedTicketByNumber 가 본다)", async () => {
    h.resolveOwnedTicketByNumber.mockResolvedValue(null);
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("v2 5xx → unavailable(502)", async () => {
    h.checkInTicket.mockRejectedValue(new h.class_V2CommerceError("boom", 500));
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (!r.ok) {
      expect(r.reason).toBe("unavailable");
      expect(r.status).toBe(502);
    }
  });
});

/**
 * 🔴 v2 거부 문구 → 사유 매핑.
 *
 * ⚠️ **문구로 가른다.** v2 는 `AdmissionError.code`(NOT_ADMITTABLE / NOT_ADMISSION_DAY)를
 *    갖고 있으면서 응답에서는 전부 `STATE_TRANSITION_FORBIDDEN` 으로 뭉쳐 보낸다
 *    (`internal_commerce.py:3654`) — 코드가 소실된다.
 *
 * ⟹ 여기서 **v2 의 실제 문구를 못박는다**. v2 가 문구를 바꾸면 조용히 오분류되는 대신
 *    이 테스트가 깨진다. 그때가 v2 에 `details.admission_code` 를 넣을 시점이다.
 */
/**
 * ✅ 2026-08-10 — v2 가 `error.details.admission_code` 를 실어 보낸다.
 *
 * 🔴 **코드가 1순위**, 문구는 폴백이다. 폴백을 지우면 구버전 v2(배포 순서가 어긋난
 *    순간)에서 **전건 오분류**된다 — 현장이 멈춘다.
 */
describe("🔴 v2 admission_code — 코드가 1순위", () => {
  it("NOT_ADMITTABLE → cancelled", () => {
    expect(classifyAdmitReject("아무 문구", "NOT_ADMITTABLE")).toBe("cancelled");
  });

  it("NOT_ADMISSION_DAY → not_admission_day", () => {
    expect(classifyAdmitReject("아무 문구", "NOT_ADMISSION_DAY")).toBe("not_admission_day");
  });

  it("🔴 코드가 문구를 **이긴다** — 둘이 어긋나도 코드를 쓴다", () => {
    // 문구는 "취소"(cancelled) 인데 코드는 입장일이다 → 코드가 정본
    expect(classifyAdmitReject("취소되었거나 만료된 티켓입니다", "NOT_ADMISSION_DAY"))
      .toBe("not_admission_day");
  });

  it("모르는 코드면 문구 폴백으로 내려간다", () => {
    expect(classifyAdmitReject("지정된 입장일이 아닙니다", "SOME_NEW_CODE"))
      .toBe("not_admission_day");
  });

  it("🔴 v2 응답의 details 를 실제로 읽는다 (중첩 봉투)", async () => {
    h.checkInTicket.mockRejectedValue(
      new h.class_V2CommerceError(
        "STATE_TRANSITION_FORBIDDEN: 아무 문구",
        422,
        JSON.stringify({
          ok: false,
          error: {
            code: "STATE_TRANSITION_FORBIDDEN",
            details: { admission_code: "NOT_ADMISSION_DAY" },
          },
        }),
      ),
    );
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(false);
    // 🔴 폴백 기본값("cancelled")과 **다른** 값을 기대한다 — 같으면 details 를 안 읽어도 통과한다
    if (!r.ok) expect(r.reason).toBe("not_admission_day");
  });

  it("평면 봉투도 읽는다 (200 + ok:false 경로)", async () => {
    h.checkInTicket.mockRejectedValue(
      new h.class_V2CommerceError(
        "STATE_TRANSITION_FORBIDDEN: 아무 문구",
        422,
        JSON.stringify({ code: "STATE_TRANSITION_FORBIDDEN", details: { admission_code: "NOT_ADMISSION_DAY" } }),
      ),
    );
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (!r.ok) expect(r.reason).toBe("not_admission_day");
  });

  it("🔴 details 가 없으면(구버전 v2) **문구 폴백**이 동작한다", async () => {
    h.checkInTicket.mockRejectedValue(
      new h.class_V2CommerceError("STATE_TRANSITION_FORBIDDEN: 지정된 입장일이 아닙니다", 422),
    );
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok, "구버전 v2 에서 현장이 멈추면 안 된다").toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_admission_day");
  });
});

describe("🔴 v2 거부 문구 매핑 — 폴백(구버전 v2 용)", () => {
  const V2_MESSAGES: ReadonlyArray<readonly [string, string]> = [
    ["취소되었거나 만료된 티켓입니다", "cancelled"],
    ["이 등급의 입장 가능일이 아닙니다", "not_admission_day"],
    ["오늘은 입장 가능일이 아닙니다", "not_admission_day"],
    ["지정된 입장일이 아닙니다", "not_admission_day"],
  ];

  it.each(V2_MESSAGES)("%s → %s", (message, reason) => {
    expect(classifyAdmitReject(message)).toBe(reason);
  });

  it("🔴 모르는 문구는 cancelled 로 — invalid(위조)로 답하지 않는다", () => {
    expect(classifyAdmitReject("알 수 없는 새 사유")).toBe("cancelled");
  });

  it("v2 4xx 거부가 403 + 사유로 번역된다", async () => {
    h.checkInTicket.mockRejectedValue(
      new h.class_V2CommerceError("STATE_TRANSITION_FORBIDDEN: 지정된 입장일이 아닙니다", 422),
    );
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not_admission_day");
      expect(r.status).toBe(403);
      expect(r.message, "코드 접두어가 그대로 나가면 안 된다").toBe("지정된 입장일이 아닙니다");
    }
  });
});

describe("🔴 오프라인 — scanned_at 을 그대로 v2 에 넘긴다", () => {
  it("과거 시각을 주면 **그 시각으로** 기록 요청한다", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T14:50:00Z", status: "used",
      already: false, outcome: "admitted", attended_date: "2026-08-20",
    });
    const at = "2026-08-20T23:50:00+09:00";
    await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO, at });
    // ⚠️ "호출됐다" 가 아니라 **무엇을 넘겼는지**를 본다. now 로 덮으면 입장일이 하루 밀린다.
    expect(h.checkInTicket).toHaveBeenCalledWith(expect.any(String), { at });
  });

  it("at 이 없으면 서버 시각을 쓴다", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T01:00:00Z", status: "used", already: false,
    });
    await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    const arg = h.checkInTicket.mock.calls[0]![1] as { at: string };
    expect(Number.isNaN(Date.parse(arg.at))).toBe(false);
  });

  it("🔴 미래 시각 거부(v2)는 사유를 뭉개지 않는다 — 이틀 입장 우회 자리", async () => {
    h.checkInTicket.mockRejectedValue(
      // v2 는 입력 오류를 **400**, 입장 자격 거부를 **422** 로 낸다 — 구조로 갈린다.
      new h.class_V2CommerceError("VALIDATION_ERROR: 입장 시각이 미래일 수 없습니다", 400),
    );
    const r = await admitTicketByNumber({
      eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO,
      at: "2026-08-21T10:00:00+09:00",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid");
      expect(r.status).toBe(400);
      expect(r.message).toContain("미래");
    }
  });
});


/**
 * 🔴 참석자 신원 (2026-08-10, 대표 확정)
 *
 * 현장 업체가 기념품·브로셔를 주고 대회 후 경품 당첨자에게 연락한다.
 *   · 이름이 **구매자**면 3장 산 사람의 지인 둘이 남의 이름으로 불린다
 *   · 전화가 없으면 동명이인을 못 가르고 당첨 연락도 못 한다
 */
describe("🔴 참석자 본인 이름·전화 — 구매자가 아니다", () => {
  it("🔴 go attendees 가 1순위 — 참석자 이름이 나온다", async () => {
    h.poolQuery.mockResolvedValue({ rows: [{ name: "참석자이", phone: "010-1234-5678" }] });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.holder.name, "구매자 이름이 나오면 게이트에서 남의 이름을 부른다").toBe("참석자이");
      expect(r.holder.phone).toBe("01012345678");
    }
  });

  it("🔴 전화는 **하이픈 없는 숫자열** — 명세서와 같은 형식", async () => {
    for (const raw of ["010-1234-5678", "010 1234 5678", "01012345678", "+82-10-1234-5678"]) {
      h.poolQuery.mockResolvedValue({ rows: [{ name: "참석자이", phone: raw }] });
      const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
      if (r.ok) expect(r.holder.phone, raw).toMatch(/^\d+$/);
    }
  });

  it("🔴 attendees 가 없으면 구매자로 폴백한다 (깨지지 않는다)", async () => {
    h.poolQuery.mockResolvedValue({ rows: [] });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (r.ok) {
      expect(r.holder.name).toBe("구매자김");
      expect(r.holder.phone).toBe("01099998888");
    }
  });

  it("attendees 행은 있는데 값이 비면 구매자로 채운다", async () => {
    h.poolQuery.mockResolvedValue({ rows: [{ name: "  ", phone: null }] });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (r.ok) {
      expect(r.holder.name).toBe("구매자김");
      expect(r.holder.phone).toBe("01099998888");
    }
  });

  it("둘 다 없으면 **빈 문자열** — null 이 아니다", async () => {
    h.resolveOwnedTicketByNumber.mockResolvedValue(
      ticketDetail({ order: { buyer: { name: null, email: null, phone: null } } }),
    );
    h.poolQuery.mockResolvedValue({ rows: [] });
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    if (r.ok) {
      expect(r.holder.name).toBe("");
      expect(r.holder.phone).toBe("");
    }
  });

  it("🔴 신원 조회가 실패해도 **입장을 막지 않는다**", async () => {
    h.poolQuery.mockRejectedValue(new Error("go DB 장애"));
    const r = await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    expect(r.ok, "부가 정보 때문에 게이트에서 사람을 세우면 안 된다").toBe(true);
    if (r.ok) expect(r.holder.name).toBe("구매자김");
  });

  it("계정 경계 — 조회에 accountId 를 건다", async () => {
    await admitTicketByNumber({ eventId: EVENT, accountId: ACCT, ticketNumber: TICKET_NO });
    const [, params] = h.poolQuery.mock.calls[0]!;
    expect(params).toEqual([ACCT, TICKET_NO]);
  });
});
