/**
 * 🔴 결제 착지 화면의 갈 곳 — **홈으로 보내지 않는다** (2026-08-04, 대표 지적).
 *
 * 「이벤트로 돌아가기」를 눌렀더니 피켓고 홈페이지가 떴다. 나이스 착지는 URL 에 slug 가
 * 없어 `orderId` 로 v2 에 물어 역산하는데, 그 왕복이 실패하면 빈 slug 가 오고 화면이
 * `"/"` 로 폴백했다.
 *
 * ⚠️ **버튼 이름이 거짓말을 하면 안 된다.** 결제를 막 끝낸 손님이 행사와 무관한 랜딩을
 *    보면 결제가 잘못됐다고 읽는다. 갈 곳을 모르면 **그 버튼을 안 그리는 편이 낫다.**
 */
import { describe, expect, it } from "vitest";
import { checkoutLandingLinks } from "./checkout-landing";

const SLUG = "bc-hankyung-klpga2026";
const ORDER = "5b3f9120-6224-5ea1-a9e8-ae752d5fcac6";

describe("slug 을 알 때 — 행사로 보낸다", () => {
  it("행사·재시도·주문 링크가 모두 그 행사를 가리킨다", () => {
    const l = checkoutLandingLinks(SLUG, ORDER);
    expect(l.eventHref).toBe(`/e/${SLUG}`);
    expect(l.retryHref).toBe(`/e/${SLUG}/checkout/payment`);
    expect(l.orderHref).toBe(`/e/${SLUG}/checkout/complete?orderId=${ORDER}`);
  });

  it("주문번호가 없으면 주문 링크는 내 티켓 — 빈 orderId 로 완료 페이지를 열지 않는다", () => {
    const l = checkoutLandingLinks(SLUG, undefined);
    expect(l.orderHref).toBe("/my-tickets");
    // 행사 링크는 살아 있다 — slug 는 알고 있다.
    expect(l.eventHref).toBe(`/e/${SLUG}`);
  });

  it("주문번호를 URL 인코딩한다", () => {
    expect(checkoutLandingLinks(SLUG, "a b&c").orderHref).toBe(
      `/e/${SLUG}/checkout/complete?orderId=a%20b%26c`,
    );
  });

  it("한글 slug 도 인코딩된다 — 이 프로젝트에 실재한다", () => {
    expect(checkoutLandingLinks("행사-슬러그", ORDER).eventHref).toBe(
      `/e/${encodeURIComponent("행사-슬러그")}`,
    );
  });
});

describe("🔴 slug 을 모를 때 — 홈으로 보내지 않는다", () => {
  const unknown = ["", "   ", null, undefined, "undefined", "null"];

  it("🔴 행사 링크를 만들지 않는다 — 호출부가 버튼을 안 그린다", () => {
    for (const s of unknown) {
      expect(checkoutLandingLinks(s, ORDER).eventHref, `slug=${String(s)}`).toBeNull();
    }
  });

  it("🔴 재시도 링크도 만들지 않는다 — 결제창인 줄 알고 누른다", () => {
    for (const s of unknown) {
      expect(checkoutLandingLinks(s, ORDER).retryHref, `slug=${String(s)}`).toBeNull();
    }
  });

  it("🔴 주문 링크는 내 티켓으로 — 홈이 아니다", () => {
    // 홈은 방금 산 것을 볼 수 없는 곳이다. 결제 직후의 손님에게 가장 나쁜 목적지.
    for (const s of unknown) {
      expect(checkoutLandingLinks(s, ORDER).orderHref, `slug=${String(s)}`).toBe("/my-tickets");
    }
  });

  it("🔴 어떤 링크도 홈(/)을 가리키지 않는다", () => {
    for (const s of unknown) {
      const l = checkoutLandingLinks(s, ORDER);
      expect([l.eventHref, l.retryHref, l.orderHref]).not.toContain("/");
    }
  });

  it("🔴 깨진 URL 을 만들지 않는다 — /e// 방지", () => {
    for (const s of unknown) {
      const l = checkoutLandingLinks(s, ORDER);
      for (const href of [l.eventHref, l.retryHref, l.orderHref]) {
        expect(href ?? "").not.toContain("/e//");
        expect(href ?? "").not.toContain("undefined");
      }
    }
  });
});
