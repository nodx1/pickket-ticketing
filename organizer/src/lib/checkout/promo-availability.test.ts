import { describe, expect, it } from "vitest";
import {
  isPromoUsable,
  shouldShowPromoInput,
  type PromoAvailabilityRow,
} from "./promo-availability";

const NOW = new Date("2026-08-01T12:00:00Z");

function row(over: Partial<PromoAvailabilityRow> = {}): PromoAvailabilityRow {
  return {
    is_active: true,
    starts_at: null,
    ends_at: null,
    usage_limit: null,
    used_count: 0,
    ...over,
  };
}

describe("isPromoUsable — 지금 실제로 쓸 수 있는 코드인가", () => {
  it("활성 + 기간 무제한 + 한도 무제한 → 사용 가능", () => {
    expect(isPromoUsable(row(), NOW)).toBe(true);
  });

  it("비활성이면 못 쓴다", () => {
    expect(isPromoUsable(row({ is_active: false }), NOW)).toBe(false);
  });

  it("시작 전이면 못 쓴다", () => {
    expect(isPromoUsable(row({ starts_at: "2026-08-02T00:00:00Z" }), NOW)).toBe(false);
  });

  it("이미 시작했으면 쓴다", () => {
    expect(isPromoUsable(row({ starts_at: "2026-07-01T00:00:00Z" }), NOW)).toBe(true);
  });

  it("종료 후면 못 쓴다", () => {
    expect(isPromoUsable(row({ ends_at: "2026-07-31T23:59:59Z" }), NOW)).toBe(false);
  });

  it("종료 전이면 쓴다", () => {
    expect(isPromoUsable(row({ ends_at: "2026-08-31T00:00:00Z" }), NOW)).toBe(true);
  });

  it("🔴 한도 소진이면 못 쓴다 — 남아 있으면 입력칸이 막다른 길이 된다", () => {
    expect(isPromoUsable(row({ usage_limit: 10, used_count: 10 }), NOW)).toBe(false);
    expect(isPromoUsable(row({ usage_limit: 10, used_count: 11 }), NOW)).toBe(false);
  });

  it("한도가 남아 있으면 쓴다", () => {
    expect(isPromoUsable(row({ usage_limit: 10, used_count: 9 }), NOW)).toBe(true);
  });

  it("usage_limit=null 은 무제한 — used_count 가 커도 쓴다", () => {
    expect(isPromoUsable(row({ usage_limit: null, used_count: 9999 }), NOW)).toBe(true);
  });

  it("날짜 문자열이 깨져 있으면 그 조건은 막지 않는다 (fail-open)", () => {
    // 데이터 이상으로 유효한 코드를 못 쓰게 만드는 쪽이 더 나쁘다.
    expect(isPromoUsable(row({ starts_at: "쓰레기값" }), NOW)).toBe(true);
    expect(isPromoUsable(row({ ends_at: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("shouldShowPromoInput — 입력칸 노출 판정", () => {
  it("쓸 수 있는 코드가 하나라도 있으면 보여준다", () => {
    expect(shouldShowPromoInput([row({ is_active: false }), row()], NOW)).toBe(true);
  });

  it("🔴 코드가 아예 없으면 숨긴다 — 이번 개선의 핵심", () => {
    expect(shouldShowPromoInput([], NOW)).toBe(false);
  });

  it("있지만 전부 못 쓰는 상태면 숨긴다", () => {
    expect(
      shouldShowPromoInput(
        [
          row({ is_active: false }),
          row({ ends_at: "2026-07-01T00:00:00Z" }),
          row({ usage_limit: 5, used_count: 5 }),
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it("🔴 조회 실패(null/undefined)면 **보여준다** — 숨기면 유효한 코드를 든 구매자가 막힌다", () => {
    expect(shouldShowPromoInput(null, NOW)).toBe(true);
    expect(shouldShowPromoInput(undefined, NOW)).toBe(true);
  });
});
