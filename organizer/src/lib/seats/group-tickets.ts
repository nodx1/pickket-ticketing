/**
 * 그룹 티켓 검증 + 인접 좌석 탐색 — v2 group_tickets 포팅 (Phase 2)
 */
import type { Seat } from "./types";

export interface GroupRequest {
  leaderId: string;
  memberIds: string[];
  tierId: string;
  size: number;
}

export interface GroupValidationResult {
  valid: boolean;
  error?: string;
}

export function validateGroupRequest(
  req: GroupRequest,
  maxGroupSize: number,
): GroupValidationResult {
  if (req.size < 2) return { valid: false, error: "그룹은 최소 2명입니다" };
  if (req.size > maxGroupSize) {
    return { valid: false, error: `최대 ${maxGroupSize}명까지 가능합니다` };
  }
  if (req.memberIds.includes(req.leaderId)) {
    return { valid: false, error: "리더는 멤버 목록에 포함될 수 없습니다" };
  }
  const dedup = new Set(req.memberIds);
  if (dedup.size !== req.memberIds.length) {
    return { valid: false, error: "중복 멤버가 있습니다" };
  }
  if (req.memberIds.length + 1 !== req.size) {
    return { valid: false, error: "그룹 인원과 멤버 수가 맞지 않습니다" };
  }
  return { valid: true };
}

/**
 * 후보 좌석 리스트에서 연속된 size 개 좌석을 찾는다.
 * 같은 section + row 내에서만 인접으로 인정.
 */
export function findAdjacentSeats(
  candidates: Seat[],
  size: number,
): Seat[] | null {
  const byRow: Record<string, Seat[]> = {};
  for (const s of candidates) {
    const key = `${s.section}:${s.row}`;
    if (!byRow[key]) byRow[key] = [];
    byRow[key].push(s);
  }
  for (const key of Object.keys(byRow)) {
    const rowSeats = byRow[key].sort(
      (a, b) => Number(a.seatNumber) - Number(b.seatNumber),
    );
    for (let i = 0; i <= rowSeats.length - size; i++) {
      const window = rowSeats.slice(i, i + size);
      const isAdjacent = window.every(
        (s, idx) =>
          idx === 0 ||
          Number(s.seatNumber) - Number(window[idx - 1].seatNumber) === 1,
      );
      if (isAdjacent) return window;
    }
  }
  return null;
}
