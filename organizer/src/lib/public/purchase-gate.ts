/**
 * 구매 진입점 개방 판정 — **순수 모듈**(React 의존 0).
 *
 * ## 🔴 왜 함수로 뽑았나 (2026-08-01 감사 P0-2)
 * 종전엔 이 판단이 두 컴포넌트(`queue-purchase-gate` · `sticky-cta-bar`) 안에 각각
 * 흩어져 있었고, 둘 다 **대기열 사용 여부와 무관하게** 잠긴 채 시작했다.
 * 구매 버튼은 `POST .../queue/join` 이 성공해야 열리는데, 그 요청은 내부에서 v2 를 부른다.
 *
 *     v2 가 한 번 흔들린다 → join 실패 → 버튼은 "구매 대기열 확인 중..." 인 채
 *     **영구히 잠긴다**(재시도 수단 없음) → 그런데 페이지 본문은 SSR 이라 멀쩡하다
 *     ⟹ **"페이지는 되는데 못 사는" 상태.** 손님은 고장난 줄도 모르고 나간다.
 *
 * 이 행사는 대기열을 쓰지 않는다. **안 쓰는 기능 때문에 결제가 잠기는 구조가 틀렸다.**
 *
 * ## ⚠️ 화면을 열어도 안전한 근거 (심증 아님 — 서버 코드로 확인)
 * 진짜 관문은 서버다. `api/checkout/initiate/route.ts:234` 가
 * **v2 에서 직접 읽은** `eventDetail.queue_enabled`(= `await getEvent(body.eventId)`,
 * 요청 본문이 아니라 서버 조회라 클라이언트가 못 속인다)로 판단하고, 켜져 있는데 입장
 * 토큰이 없으면 403 을 낸다. 그러므로 이 값이 잘못 꺼져 있어도 **대기열은 무력화되지 않는다.**
 * 화면이 하는 일은 "미리 막아 헛걸음을 줄이는 것" 이지 관문이 아니다.
 */

export interface PurchaseGateInput {
  /** 대기열 사용 여부(v2 정본). */
  queueEnabled: boolean;
  /** 매진 여부. */
  soldOut: boolean;
  /** 대기열에서 입장(active) 을 받았는가. 대기열을 안 쓰면 의미 없다. */
  admitted?: boolean;
}

/**
 * 대기열 왕복을 **보낼지**.
 *
 * 🔴 안 쓰는 행사에서 보내지 않는 것이 이 수정의 핵심이다. 보내지 않으면 실패할 요청이 없다.
 *    매진이면 어차피 못 사므로 역시 보내지 않는다(종전 동작 유지).
 */
export function shouldJoinQueue(input: Pick<PurchaseGateInput, "queueEnabled" | "soldOut">): boolean {
  return input.queueEnabled && !input.soldOut;
}

/** 구매 버튼을 **열지**. 매진이 가장 강한 조건이다. */
export function canEnterPurchase(input: PurchaseGateInput): boolean {
  if (input.soldOut) return false;
  if (!input.queueEnabled) return true; // 기다릴 것이 없다
  return input.admitted === true;
}

/**
 * 잠겨 있을 때 버튼에 쓸 말.
 *
 * ⚠️ 대기열을 안 쓰는데 "대기열 확인 중" 이라고 쓰면 **거짓말**이다 — 확인하는 대기열이 없다.
 *    그 상태는 애초에 나오지 않아야 하고(`canEnterPurchase` 가 true), 혹시 나온다면
 *    그건 대기열 문제가 아니므로 문구도 달라야 한다.
 */
export function purchaseGateLabel(input: PurchaseGateInput): string | null {
  if (input.soldOut) return "매진되었습니다";
  if (canEnterPurchase(input)) return null; // 열려 있다 — 잠금 문구 없음
  return "구매 대기열 확인 중...";
}
