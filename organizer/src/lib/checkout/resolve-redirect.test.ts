import { describe, expect, it } from "vitest";
import { checkoutRedirectPath, resolveCheckoutRedirect } from "./resolve-redirect";

/**
 * 결제 단계 리다이렉트 판정 회귀.
 *
 * 배경(2026-07-30): 이 판정이 결제 스텝의 `useEffect` 안에 인라인돼 있었고 그 이펙트가
 * 무한 렌더 루프를 만들어 **결제 페이지가 열리지 않았다**(React #185 → 에러 바운더리).
 * 판정을 순수 함수로 꺼내 테스트가 닿게 했다.
 *
 * ⚠️ 이 파일이 그린이어도 **루프가 고쳐졌다는 증거는 아니다.** deps 안정성은 화면
 *    반복 검증으로만 확인된다(계획서 §4-③). 여기서는 **판정 순서와 경로**만 고정한다.
 */

const ok = {
  orderId: null,
  itemCount: 2,
  buyerName: "홍길동",
  buyerEmail: "a@b.com",
  buyerPhone: "01012345678",
};

describe("resolveCheckoutRedirect", () => {
  it("전부 갖춰지면 머문다(null)", () => {
    expect(resolveCheckoutRedirect(ok)).toBeNull();
  });

  it("🔴 완료 주문이 있으면 완료 페이지로 — 뒤로가기 재결제 차단", () => {
    expect(resolveCheckoutRedirect({ ...ok, orderId: "ord-1" })).toEqual({
      to: "complete",
      orderId: "ord-1",
    });
  });

  it("🔴 완료 주문 판정이 빈 장바구니보다 **먼저**다", () => {
    // 순서가 뒤바뀌면: 완료 주문으로 돌아온 손님이 장바구니(빈 상태)로 튕겨
    // **결제한 티켓을 못 보고** 다시 담게 된다 → 중복 주문 유도.
    expect(resolveCheckoutRedirect({ ...ok, orderId: "ord-1", itemCount: 0 })).toEqual({
      to: "complete",
      orderId: "ord-1",
    });
  });

  it("장바구니가 비면 티켓 선택으로", () => {
    expect(resolveCheckoutRedirect({ ...ok, itemCount: 0 })).toEqual({ to: "cart" });
  });

  it.each([
    ["이름", { buyerName: "" }],
    ["이메일", { buyerEmail: "" }],
    ["전화", { buyerPhone: "" }],
  ])("구매자 %s 가 비면 정보 입력으로", (_label, patch) => {
    expect(resolveCheckoutRedirect({ ...ok, ...patch })).toEqual({ to: "details" });
  });

  it("🔴 장바구니 판정이 구매자 정보보다 먼저다 — 둘 다 비어도 티켓 선택으로", () => {
    // 정보 입력으로 보내면 담긴 것이 없어 그 화면에서 또 튕긴다(왕복 루프).
    expect(
      resolveCheckoutRedirect({ ...ok, itemCount: 0, buyerName: "", buyerEmail: "", buyerPhone: "" }),
    ).toEqual({ to: "cart" });
  });
});

describe("checkoutRedirectPath", () => {
  it("완료 페이지 경로에 orderId 를 싣는다", () => {
    expect(checkoutRedirectPath("my-event", { to: "complete", orderId: "ord-9" })).toBe(
      "/e/my-event/checkout/complete?orderId=ord-9",
    );
  });

  it("장바구니·정보 경로", () => {
    expect(checkoutRedirectPath("my-event", { to: "cart" })).toBe("/e/my-event/checkout");
    expect(checkoutRedirectPath("my-event", { to: "details" })).toBe(
      "/e/my-event/checkout/details",
    );
  });
});
