/**
 * 무통장 입금확정 대상 판정.
 *
 * ## 🔴 왜 결제수단만으로 판정하면 안 되나
 * `checkout/initiate` 는 **모든 소비자 체크아웃 주문**을 go `orders.payment_method='offline'`
 * 로 적는다(카드 결제도 포함). 그래서 결제수단만 보면 아래가 구분되지 않는다:
 *
 *   A. 진짜 무통장 주문        — 주최자가 계좌 입금을 확인하고 확정해야 한다
 *   B. 카드 결제하다 이탈한 주문 — 확정하면 **돈을 안 받고 티켓이 발권**된다
 *
 * 실제로 B 가 주최자 화면에 "입금 확인" 버튼과 함께 떴다. 노출 창은 만료 크론이
 * 정리하기 전까지(약 15분)지만, 판매가 열리면 그 창이 상시 열린다.
 *
 * 두 경우를 가르는 건 **PG 결제가 걸려 있는지**(v2 `orders.payment_id`)뿐이다.
 * v2 가 주문 상세에 `has_pg_payment` 로 내려준다.
 *
 * 서버(API)와 화면이 **같은 함수**를 쓴다. 화면만 막으면 API 를 직접 부를 수 있고,
 * API 만 막으면 주최자가 버튼을 누른 뒤 에러를 본다.
 */

/** 입금확정이 가능한 결제수단(무통장입금/오프라인). */
export const OFFLINE_PAYMENT_METHODS = ["offline", "bank_transfer"] as const;

export interface DepositEligibilityInput {
  /** go 주문 상태(6-상태 투영). */
  status: string;
  /** go `orders.payment_method`. */
  paymentMethod: string | null;
  /**
   * v2 `has_pg_payment` — PG 결제가 걸려 있는지.
   * ⚠️ `undefined`(구버전 v2 응답·조회 실패)는 **모른다**는 뜻이고, 모를 때는 막는다.
   */
  hasPgPayment: boolean | undefined;
}

export type DepositEligibility =
  /** 통과 — `paymentMethod` 는 화이트리스트를 통과한 non-null 값이다(호출부 재검사 불필요). */
  | { ok: true; paymentMethod: string }
  | { ok: false; reason: string; status: 400 | 409 };

export function checkDepositEligibility(input: DepositEligibilityInput): DepositEligibility {
  if (input.status !== "pending") {
    return { ok: false, reason: "입금확정할 수 없는 주문 상태입니다", status: 409 };
  }
  if (
    !input.paymentMethod ||
    !(OFFLINE_PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)
  ) {
    return { ok: false, reason: "무통장입금 주문만 입금확정할 수 있습니다", status: 400 };
  }
  // 🔴 fail-closed: 모르면 막는다. 잘못 열면 돈을 안 받고 티켓이 나간다.
  if (input.hasPgPayment !== false) {
    return {
      ok: false,
      reason:
        "카드·간편결제가 진행된 주문이라 입금확정할 수 없습니다. " +
        "결제가 완료되지 않았다면 주문이 자동 만료되며, 무통장으로 받으시려면 새 주문으로 진행해주세요.",
      status: 409,
    };
  }
  return { ok: true, paymentMethod: input.paymentMethod };
}

/** 주최자 화면에 "입금 확인" 버튼을 띄울지 — 서버 판정과 같은 규칙을 쓴다. */
export function showsDepositConfirmAction(input: DepositEligibilityInput): boolean {
  return checkDepositEligibility(input).ok;
}
