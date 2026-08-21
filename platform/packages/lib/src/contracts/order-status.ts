/**
 * Order Status 공유 계약 (투영 모델)
 *
 * 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * v2가 SSOT (결제/주문 처리), go는 투영 뷰만 사용
 *
 * 값의 원천(SSOT): backend/app/models/order.py::OrderStatus
 * → scripts/codegen/generate_ts_contracts.py 로 `generated/order-status.ts` 로 내보냄.
 * → 이 파일은 generated 값을 재-export 하여 hand-written projection 함수만 보강.
 */

import {
  V2_ORDER_STATUSES_GENERATED,
  type V2OrderStatusGenerated,
} from "./generated/order-status";

export const V2_ORDER_STATUSES = V2_ORDER_STATUSES_GENERATED;
export type V2OrderStatus = V2OrderStatusGenerated;

/**
 * go 6-상태 투영 모델.
 *
 * CONTRACT NOTE — `partially_refunded`:
 *   v2 OrderStatus(SSOT, backend OrderStatus.PARTIALLY_REFUNDED)에 도입되어
 *   V2_ORDER_STATUSES 에 존재한다(12-상태). V2_TO_GO_MAP 이 동일값으로 투영한다.
 *   go 6-상태 집합에도 표현용으로 존재한다. (DOMAIN_MODEL_STANDARD §3.1)
 */
export const GO_ORDER_STATUSES = [
  "pending",
  "completed",
  "cancelled",
  "refunded",
  "partially_refunded",
  "expired",
] as const;

export type GoOrderStatus = (typeof GO_ORDER_STATUSES)[number];

/** v2 → go 투영 맵
 *  NOTE: `partially_refunded`는 v2 enum에 추가되면 여기에 매핑을 추가할 것.
 *  (DOMAIN_MODEL_STANDARD §3.1 참고)
 */
const V2_TO_GO_MAP: Record<V2OrderStatus, GoOrderStatus> = {
  pending: "pending",
  payment_required: "pending",
  authorized: "pending",
  paid: "completed",
  confirmed: "completed",
  cancelled: "cancelled",
  expired: "expired",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
  deposit_held: "pending",
  deposit_refunded: "refunded",
  deposit_forfeited: "cancelled",
};

/** v2 주문 상태 → go 6-상태로 투영 */
export function projectToGoOrderStatus(v2Status: V2OrderStatus): GoOrderStatus {
  return V2_TO_GO_MAP[v2Status] ?? "pending";
}
