import { describe, expect, it } from "vitest";
import {
  buildPrescriptions,
  computeRemainingSeats,
  computeSellThrough,
  type PrescriptionInput,
} from "./prescriptions";

// 기본 입력: 아무 규칙도 발동하지 않는 "순조로운" 상태(판매율 60%, D-30, pending 0 …).
function baseInput(overrides: Partial<PrescriptionInput> = {}): PrescriptionInput {
  return {
    eventId: "ev1",
    status: "live",
    maxAttendees: 100,
    totalAttendees: 60,
    totalOrders: 55,
    daysUntilStart: 30,
    pendingOrders: 0,
    activePromoCount: 1,
    openInquiries: 0,
    seoComplete: true,
    ...overrides,
  };
}

function ids(input: PrescriptionInput): string[] {
  return buildPrescriptions(input).map((p) => p.id);
}

describe("computeSellThrough / computeRemainingSeats (파생 지표)", () => {
  it("정원 100·판매 60 → 판매율 0.6, 잔여 40", () => {
    const input = baseInput();
    expect(computeSellThrough(input)).toBeCloseTo(0.6);
    expect(computeRemainingSeats(input)).toBe(40);
  });

  it("정원 null 이면 판매율·잔여석 모두 null(규칙 비활성 신호)", () => {
    const input = baseInput({ maxAttendees: null });
    expect(computeSellThrough(input)).toBeNull();
    expect(computeRemainingSeats(input)).toBeNull();
  });

  it("초과판매(판매>정원)여도 잔여석은 0 으로 클램프", () => {
    const input = baseInput({ maxAttendees: 100, totalAttendees: 130 });
    expect(computeRemainingSeats(input)).toBe(0);
  });
});

describe("buildPrescriptions — 순조로운 상태", () => {
  it("모든 지표 양호하면 처방 없음(빈 배열)", () => {
    expect(buildPrescriptions(baseInput())).toEqual([]);
  });
});

describe("buildPrescriptions — 개별 규칙", () => {
  it("판매율 낮음 + D-day 임박 → 리마인드 처방(수치·CTA)", () => {
    const list = buildPrescriptions(
      baseInput({ totalAttendees: 30, daysUntilStart: 7 }), // 판매율 30%, 잔여 70
    );
    const p = list.find((x) => x.id === "low-sales-near-dday");
    expect(p).toBeTruthy();
    expect(p!.cta).toBe("messages");
    expect(p!.ctaHref).toBe("/events/ev1/messages?compose=1&status=not_checked_in");
    expect(p!.reason).toContain("D-7");
    expect(p!.reason).toContain("30%");
    expect(p!.reason).toContain("70석");
  });

  it("판매율 낮아도 D-day 멀면 리마인드 미발동", () => {
    expect(ids(baseInput({ totalAttendees: 30, daysUntilStart: 60 }))).not.toContain(
      "low-sales-near-dday",
    );
  });

  it("D-day 임박해도 판매율 높으면 리마인드 미발동", () => {
    // 판매율 60% (>=50%) → 낮음 아님
    expect(ids(baseInput({ totalAttendees: 60, daysUntilStart: 5 }))).not.toContain(
      "low-sales-near-dday",
    );
  });

  it("pending 주문 다수(>=3) → 결제 유도 처방(pending 세그먼트 딥링크)", () => {
    const p = buildPrescriptions(baseInput({ pendingOrders: 5 })).find(
      (x) => x.id === "pending-orders",
    );
    expect(p).toBeTruthy();
    expect(p!.cta).toBe("messages-pending");
    expect(p!.ctaHref).toContain("segment=pending");
    expect(p!.reason).toContain("5건");
  });

  it("pending 2건이면 임계값 미만 → 미발동", () => {
    expect(ids(baseInput({ pendingOrders: 2 }))).not.toContain("pending-orders");
  });

  it("프로모 미설정 + 판매 정체(<30%) → 얼리버드 처방", () => {
    const p = buildPrescriptions(
      baseInput({ activePromoCount: 0, totalAttendees: 20 }), // 판매율 20%
    ).find((x) => x.id === "no-promo-stale");
    expect(p).toBeTruthy();
    expect(p!.cta).toBe("promo-codes");
    expect(p!.ctaHref).toBe("/events/ev1/promo-codes");
    expect(p!.reason).toContain("20%");
  });

  it("프로모가 이미 있으면 얼리버드 미발동", () => {
    expect(ids(baseInput({ activePromoCount: 2, totalAttendees: 20 }))).not.toContain(
      "no-promo-stale",
    );
  });

  it("판매 정체 아님(30% 이상)이면 얼리버드 미발동", () => {
    expect(ids(baseInput({ activePromoCount: 0, totalAttendees: 40 }))).not.toContain(
      "no-promo-stale",
    );
  });

  it("매진 임박(>=90%)이고 잔여>0 → 대기열 처방", () => {
    const p = buildPrescriptions(baseInput({ totalAttendees: 95 })).find(
      (x) => x.id === "near-sold-out",
    );
    expect(p).toBeTruthy();
    expect(p!.priority).toBe(1);
    expect(p!.cta).toBe("waitlist");
    expect(p!.reason).toContain("95%");
    expect(p!.reason).toContain("5석");
  });

  it("완전 매진(잔여 0)이면 대기열 처방 미발동(권할 잔여 없음)", () => {
    expect(ids(baseInput({ totalAttendees: 100 }))).not.toContain("near-sold-out");
  });

  it("미답변 문의 누적(>=3) → CS 처방(inbox 딥링크)", () => {
    const p = buildPrescriptions(baseInput({ openInquiries: 4 })).find(
      (x) => x.id === "open-inquiries",
    );
    expect(p).toBeTruthy();
    expect(p!.cta).toBe("inbox");
    expect(p!.ctaHref).toBe("/events/ev1/inbox");
    expect(p!.reason).toContain("4건");
  });

  it("SEO 미완 + live → 검색 노출 개선 처방", () => {
    const p = buildPrescriptions(baseInput({ seoComplete: false })).find(
      (x) => x.id === "seo-incomplete",
    );
    expect(p).toBeTruthy();
    expect(p!.cta).toBe("publish");
    expect(p!.priority).toBe(3);
  });

  it("SEO 미완이어도 live 아니면 미발동(초안은 노출 무의미)", () => {
    expect(ids(baseInput({ seoComplete: false, status: "draft" }))).not.toContain(
      "seo-incomplete",
    );
  });

  it("SEO 상태 미상(null=조회실패)이면 규칙 비활성", () => {
    expect(ids(baseInput({ seoComplete: null }))).not.toContain("seo-incomplete");
  });
});

describe("buildPrescriptions — 정원 미설정(무제한) 방어", () => {
  it("정원 null 이면 판매율·매진·정체 규칙 전부 비활성", () => {
    const list = ids(
      baseInput({
        maxAttendees: null,
        totalAttendees: 5,
        daysUntilStart: 3,
        activePromoCount: 0,
      }),
    );
    expect(list).not.toContain("low-sales-near-dday");
    expect(list).not.toContain("near-sold-out");
    expect(list).not.toContain("no-promo-stale");
  });

  it("정원 null 이어도 정원 무관 규칙(pending·문의·SEO)은 정상 발동", () => {
    const list = ids(
      baseInput({
        maxAttendees: null,
        pendingOrders: 5,
        openInquiries: 5,
        seoComplete: false,
      }),
    );
    expect(list).toContain("pending-orders");
    expect(list).toContain("open-inquiries");
    expect(list).toContain("seo-incomplete");
  });
});

describe("buildPrescriptions — 우선순위 정렬·다중 처방", () => {
  it("여러 신호가 겹치면 priority 오름차순 정렬(1 최상단)", () => {
    const list = buildPrescriptions(
      baseInput({
        totalAttendees: 20, // 판매율 20% → 정체+낮음
        daysUntilStart: 5, // D-day 임박
        activePromoCount: 0,
        pendingOrders: 4, // priority 1
        openInquiries: 4, // priority 2
        seoComplete: false, // priority 3
        status: "live",
      }),
    );
    const priorities = list.map((p) => p.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    expect(priorities).toEqual(sorted);
    // 첫 처방은 priority 1(pending)이어야 함.
    expect(list[0]!.priority).toBe(1);
  });

  it("모든 처방 id 는 유일(중복 없음)", () => {
    const list = buildPrescriptions(
      baseInput({
        totalAttendees: 20,
        daysUntilStart: 5,
        activePromoCount: 0,
        pendingOrders: 4,
        openInquiries: 4,
        seoComplete: false,
      }),
    );
    const set = new Set(list.map((p) => p.id));
    expect(set.size).toBe(list.length);
  });

  it("과거 이벤트(D-day 음수)는 D-day 규칙 비활성", () => {
    expect(ids(baseInput({ totalAttendees: 20, daysUntilStart: -3 }))).not.toContain(
      "low-sales-near-dday",
    );
  });
});
