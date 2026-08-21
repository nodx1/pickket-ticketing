/**
 * 🔴 체크아웃 토큰이 가리키는 주문이 **되살릴 수 없다** (2026-08-08 실장애).
 *
 * 토큰은 localStorage 에 **영구** 저장된다. 결제창을 열기 전에 주문이 만들어지고, 이탈하면
 * PENDING 으로 남았다가 30분 뒤 EXPIRED 가 된다. 같은 브라우저로 다시 오면 같은 토큰 →
 * v2 dedup 이 그 만료 주문을 돌려주고 → 결제 준비가 거절된다.
 *
 * ⟹ **토큰을 버리면 즉시 풀린다.** 그래서 일반 오류와 갈라 둔다. 뭉뚱그리면 화면이
 *    "잠시 후 다시 시도" 라고 말하고, 손님은 기다리면 될 줄 알고 기다리다 영영 못 산다.
 */
export class CheckoutTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutTokenExpiredError";
  }
}

/** go 라우트가 이 상황에 실어 보내는 오류코드. v2 `ORDER_NOT_REPLAYABLE` 을 그대로 잇는다. */
export const ORDER_NOT_REPLAYABLE = "ORDER_NOT_REPLAYABLE";
