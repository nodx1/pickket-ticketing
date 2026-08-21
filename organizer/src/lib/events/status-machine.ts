/**
 * 이벤트 상태 머신 — 어드민 승인 플로우 포함.
 *
 * 전이 규칙:
 *   draft          → pending_review (organizer: 심사 요청)
 *                  → archived       (organizer: 취소/보관)
 *   pending_review → live           (admin only: 승인)
 *                  → rejected       (admin only: 반려)
 *                  → draft          (organizer: 요청 철회)
 *   rejected       → pending_review (organizer: 재제출)
 *                  → draft          (organizer: 수정 중)
 *                  → archived       (organizer: 포기)
 *   live           → paused         (organizer)
 *                  → archived       (organizer)
 *   paused         → live           (organizer)
 *                  → archived       (organizer)
 *   archived       → (없음 — 최종 상태)
 */

export type EventStatus =
  | "draft"
  | "pending_review"
  | "rejected"
  | "live"
  | "paused"
  | "archived";

export type Actor = "organizer" | "admin";

interface Transition {
  to: EventStatus;
  actors: Actor[];
}

const TRANSITIONS: Record<EventStatus, Transition[]> = {
  draft: [
    { to: "pending_review", actors: ["organizer"] },
    { to: "archived", actors: ["organizer"] },
  ],
  pending_review: [
    { to: "live", actors: ["admin"] },
    { to: "rejected", actors: ["admin"] },
    { to: "draft", actors: ["organizer"] }, // 주최자가 요청 철회
  ],
  rejected: [
    { to: "pending_review", actors: ["organizer"] }, // 재제출
    { to: "draft", actors: ["organizer"] },
    { to: "archived", actors: ["organizer"] },
  ],
  live: [
    { to: "paused", actors: ["organizer", "admin"] },
    { to: "archived", actors: ["organizer", "admin"] },
  ],
  paused: [
    { to: "live", actors: ["organizer", "admin"] },
    { to: "archived", actors: ["organizer", "admin"] },
  ],
  archived: [],
};

export function canTransition(
  from: EventStatus,
  to: EventStatus,
  actor: Actor,
): boolean {
  if (from === to) return true; // no-op
  const allowed = TRANSITIONS[from] ?? [];
  return allowed.some((t) => t.to === to && t.actors.includes(actor));
}

export function allowedNextStates(from: EventStatus, actor: Actor): EventStatus[] {
  return (TRANSITIONS[from] ?? [])
    .filter((t) => t.actors.includes(actor))
    .map((t) => t.to);
}
