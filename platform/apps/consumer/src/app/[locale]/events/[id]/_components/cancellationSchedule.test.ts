import { describe, expect, it } from "vitest";
import { feeScheduleRows, freeCancelUntilDays } from "./cancellationSchedule";

describe("취소 수수료 구간 — 서버 계산과 같은 해석", () => {
  it("피켓고 기본 정책을 D-8 이전 무료부터 당일 100% 까지 푼다", () => {
    const rows = feeScheduleRows([
      { days_before: 30, fee_pct: 0 },
      { days_before: 7, fee_pct: 30 },
      { days_before: 3, fee_pct: 50 },
      { days_before: 1, fee_pct: 80 },
      { days_before: 0, fee_pct: 100 },
    ]);
    expect(rows).toEqual([
      { from: null, to: 8, feePct: 0 },
      { from: 7, to: 4, feePct: 30 },
      { from: 3, to: 2, feePct: 50 },
      { from: 1, to: 1, feePct: 80 },
      { from: 0, to: 0, feePct: 100 },
    ]);
  });
  it("가장 먼 구간에도 수수료가 있으면 그보다 이전은 무료 줄을 더한다", () => {
    expect(feeScheduleRows([{ days_before: 7, fee_pct: 10 }, { days_before: 0, fee_pct: 100 }])).toEqual([
      { from: null, to: 8, feePct: 0 },
      { from: 7, to: 1, feePct: 10 },
      { from: 0, to: 0, feePct: 100 },
    ]);
  });
});


describe("주문서 무료 취소 안내", () => {
  it("기본 정책이면 행사 8일 전까지 무료(서버 계산과 같은 경계)", () => {
    expect(
      freeCancelUntilDays([
        { days_before: 30, fee_pct: 0 },
        { days_before: 7, fee_pct: 30 },
        { days_before: 3, fee_pct: 50 },
        { days_before: 1, fee_pct: 80 },
        { days_before: 0, fee_pct: 100 },
      ]),
    ).toBe(8);
  });
  it("정책이 없으면 null — 일반 환불 문구를 쓴다", () => {
    expect(freeCancelUntilDays([])).toBeNull();
    expect(freeCancelUntilDays(undefined)).toBeNull();
  });
});
