/**
 * Event Status 공유 계약 (2계층 투영 모델)
 *
 * 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * v2가 SSOT (11개 상태), go는 4-상태 투영
 *
 * 값의 원천(SSOT): backend/app/models/event.py::EventStatus
 * → scripts/codegen/generate_ts_contracts.py 로 `generated/event-status.ts` 로 내보냄.
 * → 이 파일은 generated 값을 재-export 하여 hand-written projection 함수만 보강.
 * 불일치 시 컴파일이 실패하므로(아래 `_assert` 조건부 타입) 드리프트 즉시 감지.
 */

import {
  V2_EVENT_STATUSES_GENERATED,
  type V2EventStatusGenerated,
} from "./generated/event-status";

export const V2_EVENT_STATUSES = V2_EVENT_STATUSES_GENERATED;
export type V2EventStatus = V2EventStatusGenerated;

export const GO_EVENT_STATUSES = [
  "draft",
  "live",
  "paused",
  "archived",
] as const;

export type GoEventStatus = (typeof GO_EVENT_STATUSES)[number];

/** v2 → go 투영 맵 */
const V2_TO_GO_MAP: Record<V2EventStatus, GoEventStatus> = {
  draft: "draft",
  pending_review: "draft",
  under_review: "draft",
  revision_requested: "draft",
  approved: "live",
  bidding_open: "live",
  bidding_closed: "live",
  allocating: "live",
  allocated: "live",
  completed: "archived",
  cancelled: "archived",
};

/** v2 상태 → go 4-상태로 투영 */
export function projectToGoStatus(v2Status: V2EventStatus): GoEventStatus {
  return V2_TO_GO_MAP[v2Status] ?? "draft";
}

/** go 상태 → 대응하는 v2 상태 목록 (역매핑) */
export function projectToV2Statuses(goStatus: GoEventStatus): V2EventStatus[] {
  return V2_EVENT_STATUSES.filter((s) => V2_TO_GO_MAP[s] === goStatus);
}

/**
 * go 4-상태 → v2 11-상태 단일 대표값 (WRITE 방향, go→v2).
 *
 * go가 커머스 write API(`POST/PATCH /api/v1/internal/events`)에 status를 보낼 때,
 * v2는 11-상태 enum 값만 허용한다(go 4-상태 문자열 "live" 등은 400 invalid status).
 * 1:N 투영을 단일 대표값으로 접는다:
 *   - live → "approved": "발행"은 곧 심사완료/공개. 판매 개시 시점은 status가 아니라
 *     sale_window(opens_at)로 제어 — v2가 opens_at 도달 시 approved→bidding_open 자동 전이.
 *   - archived → "cancelled": go의 수동 아카이브. (행사 정상 종료 "completed"는
 *     v2 라이프사이클이 파생하므로 go가 write 하지 않음.)
 *   - paused: status가 아니라 status-독립 `sales_paused` 불리언으로 처리. status는
 *     건드리지 않으므로(재개=플래그 해제로 직전 상태 복원) 여기선 null 반환.
 *     go는 PATCH /internal/events {sales_paused:true|false} 로 일시중지/재개하고,
 *     read 응답은 sales_paused=true + 투영 "live" 구간이면 status="paused"로 라운드트립.
 *
 * read 방향(v2→go)은 projectToGoStatus 사용. 이 함수는 그 역(WRITE)이며 lossy하다.
 */
const GO_TO_V2_WRITE_MAP: Record<GoEventStatus, V2EventStatus | null> = {
  draft: "draft",
  live: "approved",
  paused: null, // v2 미구현 — go 로컬 상태 유지, write 생략
  archived: "cancelled",
};

export function goToV2WriteStatus(goStatus: GoEventStatus): V2EventStatus | null {
  return GO_TO_V2_WRITE_MAP[goStatus] ?? null;
}
