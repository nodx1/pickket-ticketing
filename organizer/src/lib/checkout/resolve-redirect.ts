/**
 * 체크아웃 단계 리다이렉트 판정 — **순수 함수**.
 *
 * ## 🔴 왜 분리하는가 (2026-07-30 실사고)
 * 이 판정이 결제 스텝 컴포넌트의 `useEffect` 안에 인라인돼 있었고, 그 이펙트가
 * **무한 렌더 루프**를 만들었다(React #185 Maximum update depth exceeded →
 * 에러 바운더리가 "오류 발생 · 페이지를 불러올 수 없습니다" 를 띄움 = **판매 불가**).
 *
 * 루프 기전:
 *   ① `useCheckoutStore()` 를 셀렉터 없이 통째 구독
 *   ② 이펙트 안에서 `persist.rehydrate()` 호출
 *   ③ zustand 가 `set(stateFromStorage, true)` 를 **무조건** 실행(저장값 유무 무관)
 *   ④ 기본 `merge` 가 sessionStorage JSON 을 파싱 → `buyerInfo` 가 **매번 새 객체**
 *      (`partialize` 가 buyerInfo 를 저장 대상에 포함하므로)
 *   ⑤ deps `[buyerInfo, …]` 변경 → 이펙트 재실행 → ②로
 *
 * ⚠️ `sessionStorage` 는 동기라서 `set()` 이 이펙트 본문 안에서 바로 끝난다.
 *    zustand 의 `hydrationVersion` 가드는 호출이 **겹칠 때만** 뒤엣것을 살리므로
 *    이 루프를 막지 못한다(실측 확인).
 *
 * ## 왜 순수 함수인가
 * `checkout/**` 에는 컴포넌트 테스트가 **하나도 없었다**(`checkoutStore.test.ts` 만).
 * 렌더 테스트 인프라를 새로 세우는 대신 판정을 여기로 꺼내 **테스트가 닿게** 한다
 * (리포 원칙: "판정 로직은 순수 함수로 분리해야 테스트가 닿는다").
 *
 * ⚠️ 한계: 이 함수 테스트는 **"deps 가 매 렌더 바뀌는가" 를 증명하지 않는다.**
 *    그건 화면 반복 검증으로만 확인된다 — 이 파일의 그린을 수정 완료로 읽지 말 것.
 */

export interface CheckoutRedirectInput {
  /** 완료된 주문 id. 있으면 재결제 대신 완료 페이지로(중복 주문 차단). */
  orderId: string | null;
  /** 장바구니 항목 수. */
  itemCount: number;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
}

/**
 * 결제 단계에 머물러도 되는지 판정한다.
 *
 * @returns 이동해야 할 경로(이벤트 슬러그 기준 상대 경로 조각) 또는 `null`(머문다)
 *
 * 🔴 순서가 계약이다:
 *   1. `orderId` 우선 — 뒤로가기로 돌아온 완료 주문의 **재결제를 먼저 차단**한다.
 *      장바구니가 비어 있어도 이쪽이 앞선다(비었다고 처음으로 보내면 완료 주문이 가려진다).
 *   2. 장바구니 비었으면 티켓 선택으로.
 *   3. 구매자 정보가 하나라도 비었으면 정보 입력으로.
 */
export function resolveCheckoutRedirect(
  input: CheckoutRedirectInput,
): { to: "complete"; orderId: string } | { to: "cart" } | { to: "details" } | null {
  if (input.orderId) {
    return { to: "complete", orderId: input.orderId };
  }
  if (input.itemCount === 0) {
    return { to: "cart" };
  }
  if (!input.buyerName || !input.buyerEmail || !input.buyerPhone) {
    return { to: "details" };
  }
  return null;
}

/** 판정 결과 → 실제 경로. 슬러그 조립을 한 곳에 모아 호출부에서 문자열을 만들지 않게 한다. */
export function checkoutRedirectPath(
  eventSlug: string,
  target: NonNullable<ReturnType<typeof resolveCheckoutRedirect>>,
): string {
  const base = `/e/${eventSlug}/checkout`;
  switch (target.to) {
    case "complete":
      return `${base}/complete?orderId=${target.orderId}`;
    case "cart":
      return base;
    case "details":
      return `${base}/details`;
  }
}
