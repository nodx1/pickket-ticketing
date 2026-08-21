import { seatRepo } from "./repo";
import { findAdjacentSeats, validateGroupRequest, type GroupRequest } from "./group-tickets";

export interface GroupAllocationResult {
  success: boolean;
  error?: string;
  allocated?: { seatIds: string[]; holdId: string; holdToken: string; expiresAt: string };
}

/**
 * Phase 8: 단체 좌석 할당 — 인접 좌석 탐색 + 원자적 홀드
 *
 * 전략:
 * 1. 그룹 요청 검증 (크기 상한 등)
 * 2. 가용 좌석 중 인접한 N석 탐색
 * 3. 원자적 홀드 (하나라도 실패하면 전체 롤백)
 *
 * ── 레벨2 컷오버 T1 ──
 * go `seats` 가 사라져 좌석 후보를 go 에서 고를 수 없다 → 후보 탐색·홀드 전부 v2(seatRepo) 경유.
 * 시그니처에서 `PoolClient`/`seatMapId` 가 빠지고 **v2 canonical event_id** + (선택) mapIds 로 바뀌었다.
 * ★ go DB 를 전혀 만지지 않으므로 **go 트랜잭션 밖**에서 호출해야 한다(외부호출을 txn 안에 두면
 *   go 롤백 시 v2 홀드만 남는 split-brain — 지금은 홀드가 TTL 로 자동 회수되지만 경계는 지킨다).
 */
export async function allocateGroup(args: {
  /** v2 canonical event_id(events.v2_event_id). */
  v2EventId: string;
  tierId: string;
  request: GroupRequest;
  maxGroupSize: number;
  /** 좌석을 좁힐 배치도(공개 경로는 published 만). 미지정=이벤트 전량. */
  mapIds?: string[] | null;
  /**
   * v2 buyer uuid(회원). 익명(세션 기반) 호출은 생략 — v2 held_by NULL 이고
   * 반환 hold_id 가 bearer 소유권이 된다. go session id 를 여기에 넣지 말 것.
   */
  heldBy?: string | null;
}): Promise<GroupAllocationResult> {
  // 1. 요청 검증
  const validation = validateGroupRequest(args.request, args.maxGroupSize);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 2. 인접 좌석 후보 탐색 (여유분 10배 확보)
  const candidates = await seatRepo.getAvailableByTier(
    args.v2EventId,
    args.tierId,
    args.request.size * 10,
    { mapIds: args.mapIds },
  );
  const adjacent = findAdjacentSeats(candidates, args.request.size);
  if (!adjacent) {
    return { success: false, error: "인접한 좌석을 찾을 수 없습니다" };
  }

  // 3. 원자적 홀드 (all-win-or-all-lose)
  const holdResult = await seatRepo.holdSeats({
    v2EventId: args.v2EventId,
    seatIds: adjacent.map((s) => s.id),
    heldBy: args.heldBy ?? undefined,
  });

  if (holdResult.failed.length > 0) {
    // 부분 홀드 성공분 롤백 — hold_id 단위 release 는 멱등이라 재시도/중복 호출 안전.
    if (holdResult.held.length > 0) {
      await seatRepo.releaseByHoldId(holdResult.holdId);
    }
    return { success: false, error: "좌석 잠금에 실패했습니다 (동시 구매자 발생)" };
  }

  return {
    success: true,
    allocated: {
      seatIds: holdResult.held,
      holdId: holdResult.holdId,
      holdToken: holdResult.holdToken,
      expiresAt: holdResult.expiresAt,
    },
  };
}
