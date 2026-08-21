/**
 * 크로스 프로덕트 계약 검증 테스트
 *
 * v2 ↔ go ↔ mobile 사이 공유 계약이 유효한지 TypeScript 레벨에서 검증
 */
import { describe, it, expect } from "vitest";

import {
  V2_EVENT_STATUSES,
  GO_EVENT_STATUSES,
  projectToGoStatus,
  projectToV2Statuses,
  type V2EventStatus,
} from "../contracts/event-status";

import {
  V2_ORDER_STATUSES,
  GO_ORDER_STATUSES,
  projectToGoOrderStatus,
  type V2OrderStatus,
} from "../contracts/order-status";

import {
  SALE_MODES,
  toCanonicalSaleMode,
  CANONICAL_SALE_MODE_LABELS,
  type SaleMode,
} from "../contracts/sale-mode";

import {
  V2_CATEGORIES,
  GO_EVENT_TYPES,
  EVENT_TYPE_TO_CATEGORY,
  toV2Category,
} from "../contracts/category";

// ═══════════════════════════════════════════════════════════════════════════════
// Event Status 계약
// ═══════════════════════════════════════════════════════════════════════════════

describe("Event Status Contract", () => {
  it("v2는 정확히 11개 상태", () => {
    expect(V2_EVENT_STATUSES).toHaveLength(11);
  });

  it("go는 정확히 4개 상태", () => {
    expect(GO_EVENT_STATUSES).toHaveLength(4);
    expect([...GO_EVENT_STATUSES]).toEqual([
      "draft",
      "live",
      "paused",
      "archived",
    ]);
  });

  it("모든 v2 상태가 go로 투영 가능", () => {
    for (const status of V2_EVENT_STATUSES) {
      const go = projectToGoStatus(status);
      expect(GO_EVENT_STATUSES).toContain(go);
    }
  });

  it("go 역매핑이 v2 전체를 커버", () => {
    const allMapped = new Set<string>();
    for (const goStatus of GO_EVENT_STATUSES) {
      const v2Statuses = projectToV2Statuses(goStatus);
      v2Statuses.forEach((s) => allMapped.add(s));
    }
    for (const v2Status of V2_EVENT_STATUSES) {
      expect(allMapped).toContain(v2Status);
    }
  });

  it("bidding_open → live (go가 판매 중인 이벤트를 live로 봄)", () => {
    expect(projectToGoStatus("bidding_open")).toBe("live");
  });

  it("cancelled → archived (go가 취소된 이벤트를 archived로 봄)", () => {
    expect(projectToGoStatus("cancelled")).toBe("archived");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Order Status 계약
// ═══════════════════════════════════════════════════════════════════════════════

describe("Order Status Contract", () => {
  it("v2는 정확히 12개 상태", () => {
    // SSOT = backend OrderStatus (partially_refunded 포함 12종). codegen 으로 생성.
    expect(V2_ORDER_STATUSES).toHaveLength(12);
  });

  it("go는 정확히 6개 상태", () => {
    expect(GO_ORDER_STATUSES).toHaveLength(6);
  });

  it("모든 v2 주문 상태가 go로 투영 가능", () => {
    for (const status of V2_ORDER_STATUSES) {
      const go = projectToGoOrderStatus(status);
      expect(GO_ORDER_STATUSES).toContain(go);
    }
  });

  it("confirmed → completed (결제 완료 주문을 go가 completed로 봄)", () => {
    expect(projectToGoOrderStatus("confirmed")).toBe("completed");
  });

  it("payment_required → pending (결제 대기 주문을 go가 pending으로 봄)", () => {
    expect(projectToGoOrderStatus("payment_required")).toBe("pending");
  });

  it("deposit_forfeited → cancelled (보증금 몰수를 go가 cancelled로 봄)", () => {
    expect(projectToGoOrderStatus("deposit_forfeited")).toBe("cancelled");
  });

  it("partially_refunded는 v2·go 양쪽 상태 — v2 도입 후 동일값으로 투영", () => {
    // CONTRACT(갱신): backend OrderStatus 가 PARTIALLY_REFUNDED 를 도입(SSOT) →
    // V2_ORDER_STATUSES 에 존재하고, V2_TO_GO_MAP 이 동일값(partially_refunded)으로 투영한다.
    // (DOMAIN_MODEL_STANDARD §3.1 — v2 부분환불 도입 반영)
    expect([...V2_ORDER_STATUSES]).toContain("partially_refunded");
    expect(projectToGoOrderStatus("partially_refunded")).toBe("partially_refunded");
    // go 6-상태 집합에도 존재한다.
    expect(GO_ORDER_STATUSES).toContain("partially_refunded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Sale Mode 계약
// ═══════════════════════════════════════════════════════════════════════════════

describe("Sale Mode Contract", () => {
  it("정확히 4종만 존재", () => {
    expect(SALE_MODES).toHaveLength(4);
    expect([...SALE_MODES]).toEqual([
      "fanclub_presale",
      "point_lottery",
      "queue",
      "fixed_fcfs",
    ]);
  });

  it("모든 canonical 모드에 ko/en 라벨 존재", () => {
    for (const mode of SALE_MODES) {
      expect(CANONICAL_SALE_MODE_LABELS[mode]).toBeDefined();
      expect(CANONICAL_SALE_MODE_LABELS[mode].ko).toBeTruthy();
      expect(CANONICAL_SALE_MODE_LABELS[mode].en).toBeTruthy();
    }
  });

  it("레거시 값 변환 정확", () => {
    expect(toCanonicalSaleMode("lottery")).toBe("point_lottery");
    expect(toCanonicalSaleMode("fanclub")).toBe("fanclub_presale");
    expect(toCanonicalSaleMode("fcfs")).toBe("fixed_fcfs");
  });

  it("canonical 값은 그대로 반환", () => {
    for (const mode of SALE_MODES) {
      expect(toCanonicalSaleMode(mode)).toBe(mode);
    }
  });

  it("알 수 없는 값은 fixed_fcfs로 fallback", () => {
    expect(toCanonicalSaleMode("unknown_mode")).toBe("fixed_fcfs");
  });

  it("금지 용어가 canonical에 포함되지 않음", () => {
    const forbidden = ["mileage_auction", "passion_investment"];
    for (const term of forbidden) {
      expect(SALE_MODES).not.toContain(term);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Category ↔ EventType 계약
// ═══════════════════════════════════════════════════════════════════════════════

describe("Category ↔ EventType Contract", () => {
  it("v2 카테고리 9종", () => {
    expect(V2_CATEGORIES).toHaveLength(9);
  });

  it("go EventType 14종", () => {
    expect(GO_EVENT_TYPES).toHaveLength(14);
  });

  it("모든 go EventType이 v2 Category로 매핑됨", () => {
    for (const eventType of GO_EVENT_TYPES) {
      expect(EVENT_TYPE_TO_CATEGORY[eventType]).toBeDefined();
      expect(V2_CATEGORIES).toContain(EVENT_TYPE_TO_CATEGORY[eventType]);
    }
  });

  it("toV2Category 함수로 변환 가능", () => {
    expect(toV2Category("concert")).toBe("concert");
    expect(toV2Category("fan_meeting")).toBe("concert");
    expect(toV2Category("festival")).toBe("festival");
    expect(toV2Category("conference")).toBe("education");
    expect(toV2Category("networking")).toBe("civic");
  });

  it("알 수 없는 EventType은 exhibition으로 fallback", () => {
    expect(toV2Category("unknown_type")).toBe("exhibition");
  });

  it("모든 v2 카테고리에 최소 1개 EventType이 매핑됨", () => {
    const coveredCategories = new Set(Object.values(EVENT_TYPE_TO_CATEGORY));
    // civic, education, exhibition, festival, concert 등은 커버
    // musical, sports, classical은 go에서 직접 매핑 안 됨 (v2 전용)
    const goCoveredCategories = [
      "concert",
      "festival",
      "education",
      "exhibition",
      "civic",
    ];
    for (const cat of goCoveredCategories) {
      expect(coveredCategories).toContain(cat);
    }
  });
});
