import type { RaffleDrawResult } from "@/lib/v2/commerce-client";
import { getOwnedEvent } from "@/lib/v2/event-access";

// F4 추첨 go 라우트 공용 헬퍼(draw POST · draws GET 공유). route.ts 아닌 파일이므로 라우트로
// 노출되지 않는다. 테넌트 경계·앵커 해석·응답 정규화를 단일 출처로 둔다.

export interface OwnedRaffleEvent {
  /**
   * v2 canonical event id.
   * ⚠️ T2-EVT 이후로는 소유 이벤트면 **항상 non-null**(go id == v2 id)이다. 타입의 null 은
   * 호출부(draw/draws)의 "앵커 미준비" 폴백 분기를 그대로 두기 위한 하위호환 — 실제로는 도달하지 않는다.
   */
  v2EventId: string | null;
  raffleEnabled: boolean;
}

/**
 * 소유 게이트 + v2 canonical 앵커 + raffle_enabled.
 * 미소유/부재 시 null — 크로스테넌트 접근 차단(테넌트 경계 필수).
 *
 * ── 레벨2 컷오버 T2-EVT ──
 * go `events` 조회(`WHERE id=$1 AND account_id=$2`)를 폐기했다. 테넌트 경계는 v2 가 `organizer_ref`
 * 로 강제하고(불일치 → 404 → null), raffle_enabled 도 v2 상세 응답이 정본이다(go-local 아님).
 *
 * @throws EventAccessError(reason="unavailable") v2 응답불가 시 — 호출부가 "없음(404)"으로 뭉개면 안 된다.
 *   draw/draws 라우트는 이 예외를 잡아 **503**(재시도 가능)으로 통지한다. 404 로도, 빈 목록으로도
 *   뭉개지 않는다 — 둘 다 일시 장애를 "영구히 없음"으로 보이게 해 주최자의 판단을 그르친다.
 */
export async function loadOwnedRaffleEvent(
  eventId: string,
  accountId: string,
): Promise<OwnedRaffleEvent | null> {
  const event = await getOwnedEvent(eventId, accountId);
  if (!event) return null;
  return { v2EventId: event.event_id, raffleEnabled: event.raffle_enabled === true };
}

/** v2 응답(snake) → go 응답(camel). 당첨 raffle_number·seed·시각·풀크기. */
export function toGoDraw(d: RaffleDrawResult) {
  return {
    drawId: d.draw_id,
    drawKey: d.draw_key,
    seed: d.seed,
    winnerCount: d.winner_count,
    poolSize: d.pool_size,
    // 당첨 raffle_number 목록. 수신자(당첨자 신원) 매핑은 v2 미제공 → 프론트 후속에서 별도 조회.
    winningNumbers: d.winning_numbers,
    executedBy: d.executed_by,
    executedAt: d.executed_at,
  };
}
