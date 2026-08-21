/**
 * All-In Pricing (Pickket 4대 약속 P1)
 *
 * 검색 → 이벤트 카드 → 이벤트 상세 → 예매 → 결제까지
 * **동일한 최종가(all_in)** 를 노출해야 한다.
 *
 * 수수료가 결제 직전에 "짠" 하고 추가되는 Ticketmaster식 UX를 금지하고,
 * 모든 가격 표시 지점이 반드시 이 유틸을 거쳐 통일된 값을 계산한다.
 *
 * 정책 근거: docs/plans/10_POLICY_HANDBOOK.md §1.3 (4대 약속 P1)
 * 로드맵: docs/business/DICE_LAYLO_ABSORPTION_ROADMAP_2026-04-09.md
 *
 * 사용 지침:
 * - 이벤트 카드·검색 결과·상세 페이지·예매 페이지 모두 `calcAllInPrice()` 결과의 `total`을 노출
 * - 가격 옆 "i" 툴팁에는 `breakdown`을 그대로 표시 (기본가 + 수수료 = 최종가)
 * - 결제 생성 API 요청 시 `total`을 서버가 재검증한다 (불일치 시 결제 실패)
 */

export interface AllInPriceBreakdown {
  /** 주최자가 설정한 정가(face value) */
  basePrice: number;
  /** 플랫폼 예매 수수료 (원 단위, 반올림 적용 후) */
  serviceFee: number;
  /** 배송/발권비 — 티켓 유형에 따라 0일 수 있음 */
  deliveryFee: number;
  /** 할인 금액 (멤버십/쿠폰 등 — 음수가 아닌 양수로 저장하고 차감함) */
  discount: number;
  /** 최종 결제 금액 = basePrice + serviceFee + deliveryFee - discount */
  total: number;
  /** 통화 코드 (ISO 4217). 기본 KRW */
  currency: string;
}

export interface CalcAllInPriceInput {
  basePrice: number;
  /**
   * 서비스 수수료율 (0 ~ 1 사이 소수, 예: 0.033 = 3.3%).
   * 주최자 계약에 따라 조직 단위로 다를 수 있음. backend `finance_service.get_fee_rate()` 에서 조회.
   */
  serviceFeeRate?: number;
  /** 고정 수수료 (건당). 조직 정책에 따라 비율 대신 또는 병행 사용 가능 */
  serviceFeeFlat?: number;
  /** 배송/발권비 */
  deliveryFee?: number;
  /** 할인 금액 */
  discount?: number;
  /** 통화 */
  currency?: string;
  /**
   * 수수료 최소/최대 캡. 정책상 수수료가 비정상적으로 크거나 작아지는 것을 방지.
   * 기본값: min=0, max=20% of base.
   */
  minServiceFee?: number;
  maxServiceFee?: number;
}

/**
 * 최종 결제 금액(all-in)을 계산한다.
 *
 * **중요**: 반올림은 한 번만, `serviceFee` 계산 직후에 적용한다.
 * 여러 지점에서 각자 반올림하면 가격이 지점마다 1~2원 어긋나 P1 약속을 위반한다.
 */
export function calcAllInPrice(
  input: CalcAllInPriceInput,
): AllInPriceBreakdown {
  const {
    basePrice,
    serviceFeeRate = 0,
    serviceFeeFlat = 0,
    deliveryFee = 0,
    discount = 0,
    currency = "KRW",
    minServiceFee = 0,
    maxServiceFee,
  } = input;

  if (!Number.isFinite(basePrice) || basePrice < 0) {
    throw new Error(`[all-in-pricing] invalid basePrice: ${basePrice}`);
  }

  const rawFee = basePrice * serviceFeeRate + serviceFeeFlat;
  const cappedMax = maxServiceFee ?? basePrice * 0.2;
  const clamped = Math.min(Math.max(rawFee, minServiceFee), cappedMax);

  // KRW 는 원 단위로 반올림, 기타 통화는 소수 둘째 자리
  const fractionDigits = currency === "KRW" || currency === "JPY" ? 0 : 2;
  const round = (n: number) =>
    fractionDigits === 0 ? Math.round(n) : Math.round(n * 100) / 100;

  const serviceFee = round(clamped);
  const total = Math.max(0, basePrice + serviceFee + deliveryFee - discount);

  return {
    basePrice,
    serviceFee,
    deliveryFee,
    discount,
    total: round(total),
    currency,
  };
}

/**
 * 두 가격 브레이크다운이 일치하는지 검증.
 * 서버와 클라이언트가 같은 가격을 계산했는지 확인할 때 사용.
 * (예: 결제 요청 직전 서버 재계산 결과와 클라이언트 표시가 동일한지)
 */
export function isAllInPriceEqual(
  a: AllInPriceBreakdown,
  b: AllInPriceBreakdown,
): boolean {
  return (
    a.currency === b.currency &&
    a.basePrice === b.basePrice &&
    a.serviceFee === b.serviceFee &&
    a.deliveryFee === b.deliveryFee &&
    a.discount === b.discount &&
    a.total === b.total
  );
}

/**
 * 가격 툴팁용 사람이 읽을 수 있는 내역 텍스트 생성.
 * UI 컴포넌트에서 직접 포맷팅 대신 이걸 재사용해 일관성 확보.
 */
export function formatAllInBreakdown(
  breakdown: AllInPriceBreakdown,
  formatter: (value: number, currency: string) => string,
): string {
  const parts: string[] = [
    `기본가 ${formatter(breakdown.basePrice, breakdown.currency)}`,
  ];
  if (breakdown.serviceFee > 0) {
    parts.push(
      `예매수수료 ${formatter(breakdown.serviceFee, breakdown.currency)}`,
    );
  }
  if (breakdown.deliveryFee > 0) {
    parts.push(
      `발권비 ${formatter(breakdown.deliveryFee, breakdown.currency)}`,
    );
  }
  if (breakdown.discount > 0) {
    parts.push(`할인 -${formatter(breakdown.discount, breakdown.currency)}`);
  }
  parts.push(`최종 ${formatter(breakdown.total, breakdown.currency)}`);
  return parts.join(" · ");
}
