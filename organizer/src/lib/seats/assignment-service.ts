import { seatRepo } from "./repo";

export type AssignmentStrategy = "fcfs" | "lottery" | "weighted" | "best_available";

export interface Winner {
  userId: string;
  weight?: number;
  timestamp?: string;
}

/**
 * Phase 9: 할당 결과 → 실제 좌석 배정 서비스
 *
 * 전략별 승자 정렬 → quality_score DESC 로 정렬된 좌석과 1:1 매칭.
 * 반환: userId → seatId Map (seatId = v2 canonical seat_id)
 *
 * 레벨2 컷오버 T1: go `seats` 소멸 → 후보 좌석을 v2 live read 로 가져온다.
 * 시그니처에서 `PoolClient`/`seatMapId` 가 빠지고 v2 canonical event_id 로 바뀌었다.
 */
export async function assignSeats(args: {
  /** v2 canonical event_id(events.v2_event_id). */
  v2EventId: string;
  tierId: string;
  winners: Winner[];
  strategy: AssignmentStrategy;
  rngSeed?: number;
  /** 좌석을 좁힐 배치도. 미지정=이벤트 전량. */
  mapIds?: string[] | null;
}): Promise<Map<string, string>> {
  const candidates = await seatRepo.getAvailableByTier(
    args.v2EventId,
    args.tierId,
    args.winners.length,
    { mapIds: args.mapIds },
  );

  if (candidates.length < args.winners.length) {
    throw new Error(`좌석 부족: ${args.winners.length}명 필요, ${candidates.length}석 가용`);
  }

  // 좌석 품질 높은 순으로 정렬 (best seats first)
  const sortedSeats = [...candidates].sort(
    (a, b) => (b.qualityScore ?? 0.5) - (a.qualityScore ?? 0.5),
  );

  // 전략별 승자 정렬
  let sortedWinners: Winner[];
  switch (args.strategy) {
    case "fcfs":
      sortedWinners = [...args.winners].sort((a, b) =>
        (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
      );
      break;
    case "weighted":
      sortedWinners = [...args.winners].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      break;
    case "lottery":
      sortedWinners = shuffleArray([...args.winners], args.rngSeed);
      break;
    case "best_available":
    default:
      sortedWinners = [...args.winners];
      break;
  }

  // 상위 승자 → 상위 좌석 1:1 매칭
  const assignment = new Map<string, string>();
  for (let i = 0; i < sortedWinners.length; i++) {
    assignment.set(sortedWinners[i].userId, sortedSeats[i].id);
  }
  return assignment;
}

function shuffleArray<T>(arr: T[], seed?: number): T[] {
  // 단순한 LCG 기반 셔플 (재현 가능)
  const shuffled = [...arr];
  let s = seed ?? Date.now();
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
