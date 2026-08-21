import { describe, expect, it } from "vitest";

import {
  calculateCancellationRefund,
  daysUntilEventDay,
  eventDayStartUtc,
  judgeCancellation,
  toTiers,
  type CancellationTier,
} from "./cancellation-fee";

/**
 * 🔴 **골든 테이블** — 화면·주최자환불·구매자환불이 같은 답을 내는지 못박는다.
 *
 * ## 왜 필요한가 (2026-07-31 실측)
 * 같은 정책 배열을 go 와 v2 가 **정반대**로 해석했다. prod KLPGA 값
 * `[{days_before: 1, fee_pct: 100}]` 에 D-20 을 물으면
 *
 *     공개 상세 표시   "D-1 이전 0%"   ← 환불 불가로 읽힘
 *     실제 지급        100% 환불
 *
 * **화면과 돈이 정반대**였다. 이 표가 깨지면 같은 사고가 재발한다.
 *
 * ⚠️ **v2 와의 잔여 차이** — v2 `refund_service.py::request_refund`(consumer 앱 경로)는
 *    여전히 **행사 시작시각** 기준으로 일수를 세고, 정책이 비면 **플랫폼 기본단계**를 적용한다.
 *    go 가 부르는 환불 경로는 go 가 정한 금액을 그대로 집행하므로 KLPGA(=go 판매)에는
 *    영향이 없지만, **consumer 앱으로 파는 행사에서는 갈린다.** 미해결로 남긴 사실이다.
 */

/** 대표 지시(2026-07-31): "행사 당일 00시까지 100% 환불". */
const KLPGA: CancellationTier[] = [{ daysBefore: 0, feePct: 100 }];

/** KLPGA 1R = 2026-08-20 07:00 KST. 환불 경계는 시작시각이 아니라 **그날 00시** 다. */
const EVENT_START = "2026-08-19T22:00:00.000Z";

/** KST 시각을 UTC ISO 로. 테스트를 읽는 사람이 한국시각으로 생각할 수 있게. */
function kst(s: string): Date {
  return new Date(`${s}+09:00`);
}

describe("행사일 00시(KST) 기준", () => {
  it("행사 시작시각이 아니라 그날 자정을 기준으로 삼는다", () => {
    // 8/20 07:00 KST 시작 → 기준은 8/20 00:00 KST = 8/19 15:00Z
    expect(eventDayStartUtc(EVENT_START)?.toISOString()).toBe("2026-08-19T15:00:00.000Z");
  });

  it("행사 시작시각이 자정이어도 같은 날 00시가 나온다", () => {
    expect(eventDayStartUtc("2026-08-19T15:00:00.000Z")?.toISOString()).toBe(
      "2026-08-19T15:00:00.000Z",
    );
  });

  it.each([null, undefined, "not-a-date"])("잘못된 입력(%o)이면 null", (v) => {
    expect(eventDayStartUtc(v as string)).toBeNull();
  });

  it("자정 직전은 아직 '남은 날 1일' 이다 — 여기가 틀리면 하루가 통째로 어긋난다", () => {
    expect(daysUntilEventDay(EVENT_START, kst("2026-08-19T23:59:00"))).toBe(1);
    expect(daysUntilEventDay(EVENT_START, kst("2026-08-20T00:00:00"))).toBe(0);
  });
});

describe("🔴 KLPGA — 8/20 00:00 KST 까지 100% 환불", () => {
  const cases: Array<[string, number, string]> = [
    ["2026-07-31T12:00:00", 100, "D-20 · 판매 초기"],
    ["2026-08-19T00:00:00", 100, "전날 아침"],
    ["2026-08-19T23:59:00", 100, "🔴 자정 1분 전 — 아직 전액"],
    ["2026-08-20T00:00:00", 0, "🔴 자정 정각 — 여기서 끊긴다"],
    ["2026-08-20T00:01:00", 0, "자정 1분 후"],
    ["2026-08-20T06:59:00", 0, "행사 시작 1분 전"],
    ["2026-08-21T10:00:00", 0, "행사 다음날"],
  ];

  it.each(cases)("%s → 환불 %i%% (%s)", (at, expected) => {
    expect(judgeCancellation(KLPGA, EVENT_START, kst(at)).refundPct).toBe(expected);
  });

  it("금액까지 확인 — 25,000원권", () => {
    const before = calculateCancellationRefund(KLPGA, EVENT_START, 25000, kst("2026-08-19T23:59:00"));
    const after = calculateCancellationRefund(KLPGA, EVENT_START, 25000, kst("2026-08-20T00:00:00"));
    expect([before.refundAmount, before.canRefund]).toEqual([25000, true]);
    expect([after.refundAmount, after.canRefund]).toEqual([0, false]);
  });
});

describe("사고 당시 prod 값 — 이게 왜 틀렸는지 고정한다", () => {
  /** `[{days_before: 1, fee_pct: 100}]` = "행사 1일 이내 환불 불가" → 하루 일찍 막힌다. */
  const OLD: CancellationTier[] = [{ daysBefore: 1, feePct: 100 }];

  it("전날 아침에 이미 막힌다 — 대표 의도(당일 00시)보다 하루 빠르다", () => {
    expect(judgeCancellation(OLD, EVENT_START, kst("2026-08-19T09:00:00")).refundPct).toBe(0);
  });

  it("이틀 전은 아직 전액", () => {
    expect(judgeCancellation(OLD, EVENT_START, kst("2026-08-18T09:00:00")).refundPct).toBe(100);
  });
});

describe("단계 매칭 — 가장 촘촘한 단계가 이긴다(v2 규칙)", () => {
  const TIERS: CancellationTier[] = [
    { daysBefore: 30, feePct: 0 },
    { daysBefore: 7, feePct: 30 },
    { daysBefore: 3, feePct: 50 },
    { daysBefore: 1, feePct: 80 },
    { daysBefore: 0, feePct: 100 },
  ];

  it.each([
    ["2026-07-01T09:00:00", 100, "50일 전 — 어느 단계에도 안 걸림"],
    ["2026-07-25T09:00:00", 100, "26일 전 → D-30 이내(수수료 0)"],
    ["2026-08-15T09:00:00", 70, "5일 전 → D-7 이내(수수료 30)"],
    ["2026-08-18T09:00:00", 50, "2일 전 → D-3 이내(수수료 50)"],
    ["2026-08-19T09:00:00", 20, "1일 전 → D-1 이내(수수료 80)"],
    ["2026-08-20T09:00:00", 0, "당일 → D-0(수수료 100)"],
  ])("%s → 환불 %i%% (%s)", (at, expected) => {
    expect(judgeCancellation(TIERS, EVENT_START, kst(at)).refundPct).toBe(expected);
  });

  it("입력 순서를 신뢰하지 않는다 — 뒤섞어도 같은 답", () => {
    const shuffled = [TIERS[3]!, TIERS[0]!, TIERS[4]!, TIERS[2]!, TIERS[1]!];
    expect(judgeCancellation(shuffled, EVENT_START, kst("2026-08-15T09:00:00")).refundPct).toBe(70);
  });
});

describe("규정이 없을 때", () => {
  /**
   * 🔴 여기서 플랫폼 기본단계를 지어내면, 화면엔 "미설정" 이라 쓰여 있는데 돈은 깎여 나간다.
   *    (v2 `refund_service.py:224` 가 실제로 그렇게 한다 — 별건으로 정리 필요)
   */
  it.each([null, undefined, []])("규정 없음(%o)이면 전액 환불", (v) => {
    const r = judgeCancellation(v as null, EVENT_START, kst("2026-08-20T09:00:00"));
    expect([r.refundPct, r.matched]).toEqual([100, false]);
  });
});

describe("입력 방어", () => {
  it("범위를 벗어난 수수료율은 0~100 으로 가둔다", () => {
    expect(judgeCancellation([{ daysBefore: 0, feePct: 130 }], EVENT_START, kst("2026-08-20T09:00:00")).refundPct).toBe(0);
    expect(judgeCancellation([{ daysBefore: 0, feePct: -20 }], EVENT_START, kst("2026-08-20T09:00:00")).refundPct).toBe(100);
  });

  it("깨진 원소는 버린다", () => {
    const tiers = [{ daysBefore: Number.NaN, feePct: 100 }, { daysBefore: 0, feePct: 100 }] as CancellationTier[];
    expect(judgeCancellation(tiers, EVENT_START, kst("2026-08-19T09:00:00")).refundPct).toBe(100);
  });

  it("행사 일시가 없으면 환불 불가로 닫는다 — 모르면 돈을 내보내지 않는다", () => {
    const r = judgeCancellation(KLPGA, "", kst("2026-08-19T09:00:00"));
    expect([r.refundPct, r.label]).toEqual([0, "행사 일시 없음"]);
  });
});

describe("toTiers — v2 응답 형태 변환", () => {
  it("snake_case 를 그대로 받는다", () => {
    expect(toTiers([{ days_before: 0, fee_pct: 100 }])).toEqual([{ daysBefore: 0, feePct: 100 }]);
  });

  it.each([null, undefined])("%o 는 빈 배열", (v) => {
    expect(toTiers(v)).toEqual([]);
  });
});
