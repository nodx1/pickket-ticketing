/**
 * 트랙 7.10 — 좌석 시스템 알림 채널 dispatcher
 *
 * 좌석 즐겨찾기/가격 알림/companion 초대 등을 사용자 동의 채널(push/email/SMS)
 * 로 발송. 실제 발송은 백엔드 큐잉 (notifications 테이블 INSERT) 으로 위임.
 *
 * 채널 우선순위:
 *  - watch (가격 알림): push → email → SMS (앱 미설치 fallback)
 *  - companion 초대: 카카오톡 (Solapi) → SMS
 *  - 매진 풀림: push (active 사용자만)
 *
 * 본 모듈은 schema 만 정의 + 채널 라우팅. 실제 전송은 7.21 cron 또는
 * notifications 테이블 INSERT 시 후속 worker 에서 처리.
 */

// ── 레벨2 컷오버 W5-SUPPORT: go `notifications` → v2 `organizer_notifications`. ──
//
// 🔴 이관 중 발견한 **기존 결함**(go 시절부터 이 경로는 동작한 적이 없다):
//    옛 INSERT 는 `(account_id, type, title, body, link)` 였는데 go 마이그 073 의
//    `notifications` 에는 `body`·`link` 컬럼이 **없고**, NOT NULL 인 `message` 를 주지
//    않았다 → 호출되면 무조건 SQL 오류. 이관하면서 실제 스키마에 맞게 고친다:
//      body → message(본문 문자열), link → metadata.link(JSON).
import { createOrganizerNotification } from "@/lib/v2/commerce-client";

export type SeatNotifyChannel = "push" | "email" | "sms" | "kakao";
export type SeatNotifyKind =
  | "watch_available" // 매진 풀림
  | "watch_price_drop" // 가격 도달
  | "companion_invite" // 친구 함께 예매 초대
  | "hold_expiring" // 30초 전 경고
  | "seat_assigned" // 좌석 자동 배정 완료
  | "refund_released"; // 환불로 좌석 풀림

export interface SeatNotifyPayload {
  kind: SeatNotifyKind;
  accountId: string | null;
  sessionId: string | null;
  eventId: string;
  seatId?: string;
  orderId?: string;
  payload: Record<string, unknown>;
}

/**
 * 알림 생성 — notifications 테이블에 INSERT.
 * 사용자 동의(GDPR) 채널만 통과시킨다.
 */
export async function createSeatNotification(
  notify: SeatNotifyPayload,
  consentChannels: SeatNotifyChannel[] = ["push", "email"],
): Promise<{ notified: number; channels: SeatNotifyChannel[] }> {
  const channels = pickChannels(notify.kind, consentChannels);
  if (channels.length === 0) {
    return { notified: 0, channels: [] };
  }

  const titleMap: Record<SeatNotifyKind, string> = {
    watch_available: "관심 좌석이 다시 풀렸습니다",
    watch_price_drop: "관심 좌석 가격이 내려갔습니다",
    companion_invite: "친구가 함께 예매에 초대했습니다",
    hold_expiring: "좌석 잠금이 곧 만료됩니다",
    seat_assigned: "좌석이 자동 배정되었습니다",
    refund_released: "환불로 좌석이 다시 풀렸습니다",
  };

  // 알림 원장은 계정 단위 — 익명(비로그인) 수신자는 남길 곳이 없으므로 무시.
  if (!notify.accountId) {
    return { notified: 0, channels };
  }
  await createOrganizerNotification({
    account_id: notify.accountId,
    event_id: notify.eventId || null,
    type: `seat_${notify.kind}`,
    title: titleMap[notify.kind],
    // 옛 `body` 자리 — 실제 스키마의 NOT NULL `message` 로 보낸다.
    message: titleMap[notify.kind],
    // 옛 `link` 자리 + 페이로드/채널을 함께 보존.
    metadata: {
      ...notify.payload,
      channels,
      link: notify.eventId ? `/events/${notify.eventId}` : null,
      ...(notify.seatId ? { seatId: notify.seatId } : {}),
      ...(notify.orderId ? { orderId: notify.orderId } : {}),
      ...(notify.sessionId ? { sessionId: notify.sessionId } : {}),
    },
  });

  return { notified: 1, channels };
}

/**
 * 알림 종류와 사용자 동의에 따라 발송 채널 결정.
 */
export function pickChannels(
  kind: SeatNotifyKind,
  consent: SeatNotifyChannel[],
): SeatNotifyChannel[] {
  const allowed = new Set(consent);
  // 우선순위 순서대로 시도 (첫 번째 통과 채널만 사용)
  const priority: Record<SeatNotifyKind, SeatNotifyChannel[]> = {
    watch_available: ["push", "email", "sms"],
    watch_price_drop: ["push", "email", "sms"],
    companion_invite: ["kakao", "sms", "email"],
    hold_expiring: ["push"], // 푸시만 (긴급)
    seat_assigned: ["push", "email"],
    refund_released: ["push"],
  };
  const order = priority[kind] ?? ["push"];
  const result: SeatNotifyChannel[] = [];
  for (const ch of order) {
    if (allowed.has(ch)) {
      result.push(ch);
      // hold_expiring 제외 첫 번째 통과 채널 + email 보조
      if (kind !== "hold_expiring" && result.length >= 1) {
        // email 백업이 있으면 추가
        if (allowed.has("email") && !result.includes("email")) {
          result.push("email");
        }
        break;
      }
    }
  }
  return result;
}
