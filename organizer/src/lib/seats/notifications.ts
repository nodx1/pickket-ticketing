/**
 * 좌석 알림 헬퍼 — Phase 10
 *
 * 현재는 로그 전용 stub. 후속 단계에서 SSE/in-app notification 연동 예정.
 * - notifySeatHoldExpiring: 홀드 만료 2분 전 사용자 경고
 * - notifyCapacityFull: 티어 매진 시 대기열 알림
 */

export interface HoldExpiringPayload {
  sessionId: string;
  seatIds: string[];
  expiresAt: string;
}

export async function notifySeatHoldExpiring(args: HoldExpiringPayload): Promise<void> {
  // TODO(P1): SSE 채널 혹은 in-app notification 으로 전환
  console.info("[seat-notify] hold expiring", {
    sessionId: args.sessionId,
    seatCount: args.seatIds.length,
    expiresAt: args.expiresAt,
  });
}

export async function notifyCapacityFull(eventId: string, tierId: string): Promise<void> {
  // TODO(P1): waitlist 사용자에게 텔레그램/이메일 통지
  console.info("[seat-notify] tier full", { eventId, tierId });
}
