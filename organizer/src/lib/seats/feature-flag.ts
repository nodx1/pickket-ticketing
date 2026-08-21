/**
 * 좌석 시스템 feature flag — Phase 11.5 (P0-O1)
 *
 * 새 좌석 시스템 (v2 포팅) 을 이벤트 단위로 점진 롤아웃한다.
 * - SEAT_SYSTEM_NEW_EVENTS: 콤마 구분 eventId 목록, `*` 는 전체 on
 * - SEAT_SYSTEM_PERCENT: 0~100 사이 정수, eventId 해시로 버킷팅
 */

function hashEventId(eventId: string): number {
  let sum = 0;
  for (let i = 0; i < eventId.length; i += 1) {
    sum = (sum + eventId.charCodeAt(i)) % 1_000_003;
  }
  return sum % 100;
}

export function isNewSeatSystemEnabled(eventId: string): boolean {
  const rawList = process.env.SEAT_SYSTEM_NEW_EVENTS ?? "";
  const newEvents = rawList
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (newEvents.includes("*")) return true;
  if (newEvents.includes(eventId)) return true;

  const percentRaw = Number(process.env.SEAT_SYSTEM_PERCENT ?? "0");
  const percent = Number.isFinite(percentRaw)
    ? Math.max(0, Math.min(100, Math.floor(percentRaw)))
    : 0;
  if (percent <= 0) return false;
  if (percent >= 100) return true;

  return hashEventId(eventId) < percent;
}

/**
 * 트랙 7.2 — 좌석 UX 단위 feature flag (canary 점진 롤아웃).
 *
 * 환경변수 명명: `SEATS_UX_<NAME>=on|off|<percent>`
 * - "on": 항상 활성
 * - "off"/미설정: 비활성
 * - 숫자: eventId 해시 기반 백분율 분기
 *
 * 사용 예:
 *   if (isSeatUxEnabled("PINCH_ZOOM", eventId)) { ... }
 */
export type SeatUxFlag =
  | "PINCH_ZOOM" // 트랙 1.1
  | "PRICE_LABEL" // 트랙 1.2
  | "BEST_AVAILABLE" // 트랙 1.3
  | "STICKY_TIMER" // 트랙 1.4
  | "VIEW_PREVIEW" // 트랙 1.5
  | "SECTION_JUMP" // 트랙 1.6
  | "COMPANION_BOOKING" // 트랙 1.8
  | "SEAT_FAVORITES" // 트랙 1.9
  | "SEAT_COMPARE" // 트랙 1.10
  | "I18N_CURRENCY" // 트랙 1.11
  | "WEBGL_RENDERER" // 트랙 3
  | "AI_DETECT" // 트랙 4
  | "CAD_IMPORT"; // 트랙 5

export function isSeatUxEnabled(flag: SeatUxFlag, eventId?: string): boolean {
  const raw = process.env[`SEATS_UX_${flag}`] ?? "";
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0" || v === "") return false;
  const percent = Number(v);
  if (!Number.isFinite(percent) || percent <= 0) return false;
  if (percent >= 100) return true;
  if (!eventId) return false; // eventId 없으면 결정 불가
  return hashEventId(eventId) < percent;
}
