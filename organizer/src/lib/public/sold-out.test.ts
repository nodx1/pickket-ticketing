/**
 * 매진 판정 회귀 — 적대 감사 F-3.
 *
 * 이 판정식은 원래 `page.tsx`(서버 컴포넌트) 안에 인라인이라 **테스트가 닿지 못했고**,
 * 감사가 `every` → `some` 뮤테이션을 넣었는데 1220개 테스트가 전부 통과했다.
 * 아래는 그 뮤테이션을 **잡는** 단언들이다 — 지우지 말 것.
 */
import { describe, expect, it } from "vitest";
import { isEventSoldOut } from "./sold-out";

describe("isEventSoldOut", () => {
  it("판매중 등급이 전부 잔여 0 이면 매진", () => {
    expect(isEventSoldOut([{ stock: 0 }, { stock: 0 }])).toBe(true);
  });

  // 🔴 `every` → `some` 뮤테이션을 잡는 단언.
  //    일부만 소진된 걸 매진으로 표시하면 **팔 수 있는 표를 못 판다**.
  it("일부만 소진되면 매진이 아니다", () => {
    expect(isEventSoldOut([{ stock: 0 }, { stock: 5 }])).toBe(false);
  });

  // 🔴 무제한(sentinel) 처리 — 이게 깨지면 완판 오판 또는 영구 미매진.
  it("무제한 등급이 하나라도 있으면 매진이 아니다", () => {
    expect(isEventSoldOut([{ stock: 0 }, { stock: null }])).toBe(false);
  });

  it("전부 무제한이면 매진이 아니다", () => {
    expect(isEventSoldOut([{ stock: null }])).toBe(false);
  });

  // 🔴 2026-07-27 실결함 회귀: 상품이 0건일 때 매진으로 표시돼 전 이벤트가 "매진"이었다.
  //    (go products 를 읽던 시절 — 빈 배열이 곧 매진이었다)
  it("상품이 없으면 매진이 아니다 — 빈 목록을 매진으로 흘리지 않는다", () => {
    expect(isEventSoldOut([])).toBe(false);
  });

  // 판매 전/종료 등급은 재고와 무관하게 살 수 없으므로 판정에서 뺀다.
  it("판매중이 아닌 등급은 판정에서 제외한다", () => {
    // 유일한 판매중 등급이 재고가 있으면 매진 아님.
    expect(isEventSoldOut([{ stock: 0, isOnSale: false }, { stock: 3, isOnSale: true }])).toBe(false);
    // 판매중 등급이 소진되면, 판매 전 등급에 재고가 남아 있어도 매진.
    expect(isEventSoldOut([{ stock: 99, isOnSale: false }, { stock: 0, isOnSale: true }])).toBe(true);
  });

  it("판매중 등급이 하나도 없으면 매진이 아니다 (판매 전/종료 상태와 구분)", () => {
    expect(isEventSoldOut([{ stock: 0, isOnSale: false }])).toBe(false);
  });

  it("초과판매로 잔여가 음수여도 매진", () => {
    expect(isEventSoldOut([{ stock: -3 }])).toBe(true);
  });
});
