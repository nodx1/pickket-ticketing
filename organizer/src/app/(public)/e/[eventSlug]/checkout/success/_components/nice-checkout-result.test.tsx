// @vitest-environment jsdom
/**
 * 🔴 결제 결과 화면 — **어느 갈래에서도 갈 곳이 있어야 한다.**
 *
 * ## 왜 생겼나
 * 2026-08-02 대표 실사용 지적: **결제가 성공했을 때만** 버튼이 하나였다
 * (「예약 내역 확인」). 행사 페이지로 돌아갈 길이 없다.
 *
 * 뒤로가기는 쓸 수 없다 — 결제창으로 되돌아가는 경로다. 그래서 다른 날짜 티켓을
 * 더 사려는 손님(주중권 15,000 ↔ 주말권 25,000)은 주소를 직접 치거나 이탈한다.
 *
 * 같은 파일의 `vbank_pending`·오류 갈래는 **처음부터 버튼이 둘**이었다.
 * 성공 갈래만 빠져 있었다 — 가장 많이 지나가는 길인데.
 *
 * ## 무엇을 고정하나
 * 문자열이 아니라 **렌더된 링크의 `href` 값**을 단언한다. 문구만 있고 링크가
 * 엉뚱한 곳을 가리키면 손님에겐 똑같이 막힌 길이다.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NiceCheckoutResult } from "./nice-checkout-result";

vi.mock("@/lib/stores/checkoutStore", () => ({
  useCheckoutStore: () => ({ reset: vi.fn() }),
}));

const SLUG = "bc카드한경-klpga-챔피언십";
/**
 * 🔴 링크는 **인코딩된 slug** 를 쓴다 (2026-08-04).
 *
 * 종전 이 컴포넌트만 raw 템플릿(`/e/${slug}`)이라 같은 리포의 `complete/page.tsx`
 * (`eventPagePath` → 인코딩)와 갈려 있었다. 받는 쪽 `normalizeEventSlug` 가
 * `decodeURIComponent` 하므로 인코딩본이 정본이다(2026-07-27 한글 slug 404 방어).
 */
const ENC = `/e/${encodeURIComponent(SLUG)}`;

function links() {
  return screen.getAllByRole("link").map((a) => ({
    text: (a.textContent ?? "").trim(),
    href: a.getAttribute("href"),
  }));
}

describe("결제 완료(confirmed)", () => {
  it("🔴 행사 페이지로 돌아갈 링크가 있다 — 막다른 길 금지", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="confirmed" orderId="ord-1" />);
    const back = links().find((l) => l.text.includes("이벤트로"));
    expect(back, "결제 후 행사로 돌아갈 길이 없다").toBeDefined();
    expect(back?.href).toBe(ENC);
  });

  it("예약 내역 확인이 주문으로 연결된다", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="confirmed" orderId="ord-1" />);
    const go = links().find((l) => l.text.includes("예약 내역"));
    expect(go?.href).toBe(`${ENC}/checkout/complete?orderId=ord-1`);
  });

  it("🔴 링크가 **둘 다** 있다 — 하나만 있으면 예전 상태다", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="confirmed" orderId="ord-1" />);
    expect(links().length).toBeGreaterThanOrEqual(2);
  });

  it("주문번호가 없으면 예약 내역이 행사 페이지로 폴백한다 — 깨진 URL 금지", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="confirmed" />);
    for (const l of links()) {
      expect(l.href, `깨진 링크: ${l.href}`).not.toContain("undefined");
      expect(l.href).not.toContain("//checkout");
    }
  });

  /**
   * 🔴 slug 해석 실패(이벤트-비의존 착지)에서는 빈 문자열이 온다.
   *
   * 옛 계약은 **홈("/")으로 폴백**이었다. 2026-08-04 대표 지적으로 뒤집혔다 —
   * 「이벤트로 돌아가기」를 눌렀는데 피켓고 홈페이지가 뜨면 손님은 결제가 잘못된 줄 안다.
   * ⟹ 행사 버튼은 **그리지 않고**, 주문 버튼은 **내 티켓**으로 보낸다.
   */
  it("slug 가 비어도 깨진 URL 을 만들지 않는다", () => {
    render(<NiceCheckoutResult eventSlug="" reason="confirmed" orderId="ord-1" />);
    for (const l of links()) {
      expect(l.href, `깨진 링크: ${l.href}`).not.toMatch(/\/e\/(\?|$|\/)/);
    }
  });

  it("🔴 slug 를 모르면 「이벤트로 돌아가기」를 아예 안 그린다 — 거짓 목적지 금지", () => {
    render(<NiceCheckoutResult eventSlug="" reason="confirmed" orderId="ord-1" />);
    expect(screen.queryByText("이벤트로 돌아가기")).toBeNull();
  });

  it("🔴 slug 를 모를 때 어떤 링크도 홈(/)이 아니다", () => {
    render(<NiceCheckoutResult eventSlug="" reason="confirmed" orderId="ord-1" />);
    const hrefs = links().map((l) => l.href);
    expect(hrefs, `홈으로 가는 링크가 있다: ${hrefs.join(" · ")}`).not.toContain("/");
  });

  it("🔴 slug 를 모르면 예약 내역이 내 티켓으로 간다 — 방금 산 것을 볼 수 있는 곳", () => {
    render(<NiceCheckoutResult eventSlug="" reason="confirmed" orderId="ord-1" />);
    expect(screen.getByText("예약 내역 확인").closest("a")?.getAttribute("href")).toBe("/my-tickets");
  });
});

describe("다른 갈래도 갈 곳이 있다 (회귀 방지)", () => {
  it("가상계좌 입금대기 — 링크 2개", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="vbank_pending" orderId="ord-1" />);
    expect(screen.getByText("가상계좌 입금 대기 중")).toBeInTheDocument();
    expect(links().length).toBeGreaterThanOrEqual(2);
  });

  it("알 수 없는 상태 — 예약 내역 + 문의 경로", () => {
    render(<NiceCheckoutResult eventSlug={SLUG} reason="weird_state" orderId="ord-1" />);
    expect(screen.getByText("결제 상태 확인 중")).toBeInTheDocument();
    const mail = links().find((l) => (l.href ?? "").startsWith("mailto:"));
    expect(mail?.href, "문의할 곳이 없다").toBe("mailto:support@pickket.kr");
  });
});
