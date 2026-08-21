/**
 * Phase E.3/E.4 — 푸시 탭 응답 핸들러
 *
 * 푸시 알림을 사용자가 탭했을 때 data 필드를 보고 적절한 화면으로 이동한다.
 * 지원하는 data.type:
 *  - weekly_curation: Discover 탭으로 이동 (첫 추천 이벤트 하이라이트)
 *  - friend_favorite / friend_activity: 친구가 관심 표시한 이벤트 상세
 *  - price_watch / price_drop: 이벤트 상세
 *  - location_nearby: 이벤트 상세
 *  - allocation_result / payment_reminder: 티켓 / 주문 화면
 *  - event_open_d30 / event_open_d5: 이벤트 상세 (티켓오픈 D-30/D-5)
 *  - event_open_imminent: 10분 전 → Live Activity 업데이트 + 이벤트 상세
 *  - event_open_live: 지금 열림 → Live Activity 업데이트 + 이벤트 상세
 *  - post_event_stamp: 공연 종료 후 → 팬 스탬프 화면
 */
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { reportError } from "@/lib/crash-reporting";
import { updateActivity } from "@/lib/live-activity";

type PushData = Record<string, unknown>;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
function safeId(v: unknown): string | null {
  const s = asString(v);
  return s && SAFE_ID.test(s) ? s : null;
}

export function handlePushResponse(data: PushData) {
  try {
    const type = asString(data.type) ?? asString(data.category);
    const eventId = safeId(data.event_id);
    const ticketId = safeId(data.ticket_id);
    const orderId = safeId(data.order_id);

    switch (type) {
      case "weekly_curation":
      case "WEEKLY_CURATION": {
        const firstId = Array.isArray(data.event_ids) && data.event_ids.length > 0
          ? safeId(data.event_ids[0])
          : null;
        if (firstId) {
          router.push(`/event/${firstId}` as never);
        } else {
          router.push("/(tabs)/index" as never);
        }
        return;
      }
      case "friend_favorite":
      case "friend_activity":
      case "FRIEND_FAVORITE":
      case "FRIEND_ACTIVITY":
      case "price_watch":
      case "price_drop":
      case "PRICE_WATCH":
      case "PRICE_DROP":
      case "location_nearby":
      case "LOCATION_NEARBY":
      case "event_update":
        if (eventId) router.push(`/event/${eventId}` as never);
        return;
      case "allocation_result":
      case "payment_reminder":
        if (ticketId) router.push(`/ticket/${ticketId}` as never);
        else if (orderId) router.push(`/order/${orderId}` as never);
        return;

      // Phase 9 — 티켓오픈 카운트다운 / Live Activity 연동
      case "event_open_d30":
      case "event_open_d5":
        if (eventId) router.push(`/event/${eventId}` as never);
        return;

      case "event_open_imminent":
        if (eventId) {
          void updateActivity(eventId, {
            phase: "imminent",
            subscriberCount:
              typeof data.subscriber_count === "number"
                ? data.subscriber_count
                : undefined,
            message: asString(data.message) ?? undefined,
          });
          router.push(`/event/${eventId}` as never);
        }
        return;

      case "event_open_live":
        if (eventId) {
          void updateActivity(eventId, {
            phase: "live",
            subscriberCount:
              typeof data.subscriber_count === "number"
                ? data.subscriber_count
                : undefined,
            message: asString(data.message) ?? undefined,
          });
          router.push(`/event/${eventId}` as never);
        }
        return;

      case "post_event_stamp":
        if (eventId) router.push(`/fan-stamp/${eventId}` as never);
        return;

      default:
        if (eventId) router.push(`/event/${eventId}` as never);
        return;
    }
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "push_response" },
    });
  }
}

/** 앱 시작 시 한 번 호출 — 푸시 탭 리스너 등록. */
export function initPushResponseHandler() {
  // 이미 실행 중인 앱에서 푸시 탭
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as PushData | undefined;
    if (data) handlePushResponse(data);
  });

  // 앱이 푸시 탭으로 콜드 스타트된 경우
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) {
        const data = response.notification.request.content.data as PushData | undefined;
        if (data) handlePushResponse(data);
      }
    })
    .catch(() => {});

  return sub;
}
