/**
 * Category ↔ EventType 매핑 계약
 *
 * 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * v2 category (8종, 소비자 검색용) — v2 SSOT
 * go eventType (14종, 주최자 세부 분류) — go SSOT
 *
 * V2_CATEGORIES 값의 원천(SSOT): backend/app/models/event.py
 *   CHECK 제약 `ck_events_category_valid`
 * → scripts/codegen/generate_ts_contracts.py 로 `generated/category.ts` 로 내보냄.
 * → 이 파일은 generated 값을 재-export 하고 매핑 함수만 보강.
 */

import {
  V2_CATEGORIES_GENERATED,
  type V2CategoryGenerated,
} from "./generated/category";

/** v2 카테고리 (소비자 검색용 — SSOT) */
export const V2_CATEGORIES = V2_CATEGORIES_GENERATED;

export type V2Category = V2CategoryGenerated;

/** go 이벤트 타입 (주최자 분류 — go SSOT) */
export const GO_EVENT_TYPES = [
  "concert",
  "fan_meeting",
  "festival",
  "local_festival",
  "party",
  "conference",
  "lecture",
  "seminar",
  "workshop",
  "mice",
  "exhibition",
  "preview",
  "flea_market",
  "networking",
] as const;

export type GoEventType = (typeof GO_EVENT_TYPES)[number];

/** go eventType → v2 category 매핑 */
export const EVENT_TYPE_TO_CATEGORY: Record<GoEventType, V2Category> = {
  concert: "concert",
  fan_meeting: "concert",
  festival: "festival",
  local_festival: "festival",
  party: "festival",
  conference: "education",
  lecture: "education",
  seminar: "education",
  workshop: "education",
  mice: "exhibition",
  exhibition: "exhibition",
  preview: "exhibition",
  flea_market: "exhibition",
  networking: "civic",
};

/** go eventType → v2 category 변환 (기본값: exhibition) */
export function toV2Category(eventType: string): V2Category {
  return EVENT_TYPE_TO_CATEGORY[eventType as GoEventType] ?? "exhibition";
}
