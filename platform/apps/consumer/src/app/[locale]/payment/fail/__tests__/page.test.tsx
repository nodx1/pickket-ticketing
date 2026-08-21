/**
 * 🔴 결제 실패 착지 화면 — **막다른 길이 되지 않는가.**
 *
 * ## 왜 이 화면인가
 * 실패 경로는 정상 경로보다 검증이 얇다. 2026-08-01 에 구매 진입점에서 정확히 이 형태의
 * 결함이 났다 — 화면은 뜨는데 **다음에 할 수 있는 게 없어서** 손님이 갇혔다.
 * 여기는 **결제가 실패한 직후**라 갇히면 곧바로 매출 손실이다.
 *
 * ## 고정하는 계약
 * ```
 * 어떤 조합으로 와도  다음 행동 링크가 정확히 하나 있다        (막다른 길 금지)
 * order 가 있으면     주문 상세로 → 재시도 가능
 * guest=1 이면        게스트 주문 경로로  (회원 경로로 보내면 로그인 벽에 막힌다)
 * order 가 없으면     이벤트 목록으로     (링크 자체가 사라지면 안 된다)
 * provider=nicepay    order · orderId **둘 다** 수용
 * ```
 *
 * ⚠️ 마지막 줄은 파라미터명이 갈리기 때문이다 — 서버는 나이스에 `orderId` 를,
 *    토스에는 `order` 를 붙인다(`payment_webhook.py:515` / `_nice_redirect_url`).
 *    한쪽만 보면 **재시도 링크가 사라진다.**
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PaymentFailPage from "../page";

/**
 * 나이스 분기는 별도 컴포넌트로 위임된다. 그 내부가 아니라 **무엇을 넘기는지**가
 * 이 페이지의 계약이므로 props 만 붙잡는다.
 */
const niceProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("../../_components/NicePaymentResult", () => ({
  NicePaymentResult: (props: Record<string, unknown>) => {
    niceProps.last = props;
    return <div data-testid="nice-result" />;
  },
}));

type Query = Record<string, string | undefined>;

async function renderFail(query: Query, locale = "ko") {
  niceProps.last = null;
  const ui = await PaymentFailPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(query),
  });
  return render(ui);
}

/** 화면에 남은 "다음 행동" 링크들. */
function actionLinks() {
  return screen.queryAllByRole("link");
}

describe("결제 실패 화면 — 토스 경로", () => {
  it("🔴 주문이 있으면 주문 상세로 갈 수 있다 — 재시도 경로", async () => {
    await renderFail({ order: "ord-1", code: "REJECT" });
    const links = actionLinks();
    expect(links, "다음 행동이 없다 — 막다른 길이다").toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/ko/orders/ord-1");
  });

  it("🔴 게스트는 게스트 주문 경로로 간다 — 회원 경로면 로그인 벽에 막힌다", async () => {
    await renderFail({ order: "ord-1", guest: "1" });
    expect(actionLinks()[0]).toHaveAttribute("href", "/ko/guests/orders/ord-1");
  });

  it("🔴 주문 정보가 없어도 링크는 남는다 — 이벤트 목록으로", async () => {
    await renderFail({ code: "UNKNOWN" });
    const links = actionLinks();
    expect(links, "주문이 없으면 아무 데도 못 간다 — 갇힌다").toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/ko/events");
  });

  it("locale 이 바뀌면 링크도 따라간다", async () => {
    await renderFail({ order: "ord-1" }, "en");
    expect(actionLinks()[0]).toHaveAttribute("href", "/en/orders/ord-1");
  });

  it("사용자 취소는 실패와 다르게 안내하고 오류코드를 안 보여준다", async () => {
    await renderFail({ order: "ord-1", code: "PAY_PROCESS_CANCELED" });
    expect(screen.getByText("결제가 취소되었습니다")).toBeInTheDocument();
    expect(
      screen.queryByText(/오류코드/),
      "손님이 스스로 취소한 것에 오류코드를 보여주면 사고처럼 읽힌다",
    ).not.toBeInTheDocument();
  });

  it("PG 가 준 메시지를 그대로 보여준다", async () => {
    await renderFail({ order: "ord-1", code: "LIMIT_EXCEEDED", message: "한도를 초과했습니다" });
    expect(screen.getByText("한도를 초과했습니다")).toBeInTheDocument();
    expect(screen.getByText(/오류코드: LIMIT_EXCEEDED/)).toBeInTheDocument();
  });

  it("메시지가 없으면 빈칸이 아니라 기본 안내가 나온다", async () => {
    await renderFail({ order: "ord-1", code: "SOMETHING" });
    expect(screen.getByText(/다시 시도해 주세요/)).toBeInTheDocument();
  });
});

describe("결제 실패 화면 — 나이스 경로", () => {
  it("provider=nicepay 면 전용 화면으로 위임한다", async () => {
    await renderFail({ provider: "nicepay", reason: "user_cancel", orderId: "ord-9" });
    expect(screen.getByTestId("nice-result")).toBeInTheDocument();
    expect(niceProps.last).toMatchObject({ variant: "fail", reason: "user_cancel" });
  });

  /**
   * 🔴 파라미터명이 갈리는 자리다. 서버는 나이스에 `orderId` 를 붙인다
   * (`_nice_redirect_url`: `params["orderId"] = order_id`).
   * `order` 만 보면 주문을 잃고 재시도 링크가 사라진다.
   */
  it("🔴 orderId 로 와도 주문을 잃지 않는다", async () => {
    await renderFail({ provider: "nicepay", reason: "auth_failed", orderId: "ord-9" });
    expect(niceProps.last?.orderId, "서버가 쓰는 이름을 안 받는다").toBe("ord-9");
  });

  it("order 로 와도 받는다 — 두 이름 모두 수용", async () => {
    await renderFail({ provider: "nicepay", reason: "auth_failed", order: "ord-7" });
    expect(niceProps.last?.orderId).toBe("ord-7");
  });

  it("둘 다 오면 order 가 이긴다", async () => {
    await renderFail({ provider: "nicepay", reason: "x", order: "ord-7", orderId: "ord-9" });
    expect(niceProps.last?.orderId).toBe("ord-7");
  });
});
