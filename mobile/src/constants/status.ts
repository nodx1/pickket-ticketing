/**
 * 도메인 상태 상수 (Canonical Status Constants)
 *
 * v2 SSOT(@pickket/lib contracts) 정렬. 로컬 enum 재정의 금지
 * (CLAUDE.md / DOMAIN_MODEL_STANDARD). 값은 v2 API 응답과 동일.
 *
 * 티켓 상태는 `satisfies Record<string, V2TicketStatus>` 로 컴파일타임 SSOT 가드:
 * v2 TicketStatus 가 바뀌거나 여기에 잘못된 값이 들어가면 tsc 가 즉시 실패한다.
 * (type-only import 라 런타임 번들 의존 없음)
 *
 * NOTE: 과거의 `checked_in`/`issued`/`paid`(티켓), `open`/`closed`/`sold_out`(이벤트),
 *       `sale_status`(이벤트)는 v2 SSOT에 존재하지 않는 값이라 제거됨.
 *       - 현장 입장 = 티켓 `used` (별도 체크인 상태 없음)
 *       - 매진 여부 = `event.is_sold_out`(집계 파생 필드)로 판단
 */
import type { V2TicketStatus } from "@pickket/lib/contracts/ticket-status";
// 주의: contracts/order-status(hand-written)는 go-투영 맵을 포함하며 현재 v2 in-flight
// 이슈로 partially_refunded 키 누락 → 타입 에러. 앱은 v2 enum union 만 필요하므로
// 자동생성 SSOT(generated)를 직접 import 해 go-투영 로직과 디커플링한다.
import type { V2OrderStatusGenerated as V2OrderStatus } from "@pickket/lib/contracts/generated/order-status";

// ── 티켓 상태 (v2 TicketStatus SSOT) ──
export const TICKET_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  TRANSFERRED: "transferred",
  CANCELLED: "cancelled",
  USED: "used",
  EXPIRED: "expired",
} as const satisfies Record<string, V2TicketStatus>;

export type TicketStatus = V2TicketStatus;

// ── 주문 상태 (v2 OrderStatus SSOT — 소문자) ──
// v2 는 order.status 를 소문자 enum 으로 내보낸다(`order.status.value`).
// app 은 이 상수로만 비교/표시한다(대문자 리터럴 비교 금지 — 항상 false 버그 원인).
// `satisfies Record<string, V2OrderStatus>` 로 컴파일타임 SSOT 가드:
// v2 OrderStatus 가 바뀌거나 잘못된 값이 들어가면 tsc 가 즉시 실패한다.
export const ORDER_STATUS = {
  PENDING: "pending",
  PAYMENT_REQUIRED: "payment_required",
  AUTHORIZED: "authorized",
  PAID: "paid",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  PARTIALLY_REFUNDED: "partially_refunded",
  REFUNDED: "refunded",
} as const satisfies Record<string, V2OrderStatus>;

export type OrderStatus = V2OrderStatus;

// ── 멤버십 상태 (app 자체 UI 개념 — v2 도메인 무관) ──
export const MEMBERSHIP_STATUS = {
  ACTIVE: "active",
} as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[keyof typeof MEMBERSHIP_STATUS];

// ── 친구 요청 상태 (app 자체 UI 개념) ──
export const FRIEND_STATUS = {
  PENDING: "pending",
} as const;

export type FriendStatus = (typeof FRIEND_STATUS)[keyof typeof FRIEND_STATUS];
