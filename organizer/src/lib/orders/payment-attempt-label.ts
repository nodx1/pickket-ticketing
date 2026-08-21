/**
 * 🔴 「결제창 이탈」과 「결제 실패」를 가르는 **단 하나의 판정** (2026-08-10).
 *
 * ## 왜 필요한가
 *
 * 주최자 목록에는 둘 다 `pending`/`expired` 로만 보인다. 오늘 「결제가 안 된다」 민원 3건이
 * **전부 이탈**이었는데, 확인하느라 v2 DB 를 직접 파야 했다(반나절). 대회 3일간 반복되면
 * 감당이 안 된다.
 *
 * ```
 * 시도 0건    → "결제창에서 나감"   나이스에 요청조차 안 갔다. 우리 시스템은 정상이다
 * failed      → "결제 실패"        실제로 거절됐다
 * succeeded   → (표시 없음)        기존 상태 그대로
 * ```
 *
 * ⚠️ **주문 상태(status)를 바꾸지 않는다.** 표시만 더한다 — 상태 머신을 건드리면
 *    정산·환불이 흔들린다.
 *
 * ⚠️ v2 `last_error`(원문)를 화면에 쓰지 않는다. "reconciliation: PG status failed" 같은
 *    내부 문구다 — 주최자가 못 읽고 우리 사정이 밖으로 샌다. **분류만** 쓴다.
 */

/** v2 `payment_attempts` 요약. 구버전 v2 는 안 준다 — 그때는 `undefined`. */
export interface PaymentAttemptSummary {
  attempt_count: number;
  last_status: string | null;
  /** 분류(기계용). 화면은 이것만 쓴다. */
  last_error_kind: string | null;
  /** 🔴 원문(진단용). **화면에 노출하지 않는다.** */
  last_error: string | null;
  last_at: string | null;
}

export type PaymentAttemptKind = "abandoned" | "failed" | "attempted" | "unknown";

/** 분류 → 주최자가 읽을 한 마디. 모르는 분류는 사유 없이 「결제 실패」만 말한다. */
const ERROR_KIND_LABEL: Readonly<Record<string, string>> = {
  pg_declined: "카드사 거절",
  timeout: "응답 지연",
};

export interface PaymentAttemptView {
  kind: PaymentAttemptKind;
  /** 화면 문구. 표시할 게 없으면 `null`(기존 표시 그대로). */
  label: string | null;
}

/**
 * 「결제창을 열었다가 그만둘 수 있는」 상태. 이것 말고는 시도 0건이 이탈을 뜻하지 않는다.
 *
 * 🔴 초대권·수동발권·0원 주문은 **결제창 자체가 없다**. 그래서 시도가 영원히 0건이다.
 *    상태를 안 보면 발권 완료된 주문이 「결제창에서 나감」으로 뜬다
 *    (2026-08-10 배포 직후 실측: 확정·환불 주문 27건이 정확히 그 상태였다).
 */
const ABANDONABLE_STATUSES: ReadonlySet<string> = new Set(["pending", "expired"]);

/**
 * 🔴 `undefined`(구버전 v2)면 **아무것도 말하지 않는다**.
 *
 * 모르는데 "결제창에서 나감" 이라고 하면 그게 오안내다 — 배포 순서가 어긋난 순간
 * 전건이 이탈로 보인다.
 *
 * @param orderStatus go 6-상태 투영. 🔴 **기본값을 두지 않는다** — 새 호출부가 말없이
 *   빠져나가 발권 주문을 이탈로 표시하는 걸 막는다(호출부가 반드시 넘기게).
 */
export function paymentAttemptView(
  summary: PaymentAttemptSummary | null | undefined,
  orderStatus: string,
): PaymentAttemptView {
  if (!summary) return { kind: "unknown", label: null };

  if (summary.attempt_count === 0) {
    // 확정·환불·취소된 주문의 시도 0건은 이탈이 아니라 **결제창을 안 거친 발권**이다.
    if (!ABANDONABLE_STATUSES.has(orderStatus)) return { kind: "unknown", label: null };
    return { kind: "abandoned", label: "결제창에서 나감" };
  }
  if (summary.last_status === "failed") {
    const detail = summary.last_error_kind
      ? ERROR_KIND_LABEL[summary.last_error_kind]
      : undefined;
    return { kind: "failed", label: detail ? `결제 실패 (${detail})` : "결제 실패" };
  }
  // succeeded · initiated — 기존 상태 표시가 이미 정확하다. 덧붙이지 않는다.
  return { kind: "attempted", label: null };
}
