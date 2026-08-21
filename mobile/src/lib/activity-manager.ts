import { Platform } from "react-native";
import {
  startTicketOpenActivity,
  
  endActivity,
} from "./live-activity";
import {
  startOngoingNotification,
  dismissOngoingNotification,
} from "./ongoing-notification";

/**
 * 크로스 플랫폼 Activity 매니저
 * iOS: Live Activity (Dynamic Island + 잠금화면)
 * Android: Ongoing Notification
 */

interface StartParams {
  eventId: string;
  title: string;
  venue: string;
  targetDate: string;
  brandColor: string;
  subscriberCount: number;
}

const androidNotificationIds = new Map<string, string>();

/** 티켓오픈 카운트다운 시작 */
export async function startCountdown(params: StartParams): Promise<void> {
  if (Platform.OS === "ios") {
    await startTicketOpenActivity(params);
  } else {
    const id = await startOngoingNotification({
      eventId: params.eventId,
      title: `🎫 ${params.title}`,
      body: `${params.venue} · 티켓오픈 카운트다운`,
      color: params.brandColor,
    });
    if (id) androidNotificationIds.set(params.eventId, id);
  }
}

/** 카운트다운 종료 */
export async function stopCountdown(eventId: string): Promise<void> {
  if (Platform.OS === "ios") {
    await endActivity(eventId);
  } else {
    const nId = androidNotificationIds.get(eventId);
    if (nId) {
      await dismissOngoingNotification(nId);
      androidNotificationIds.delete(eventId);
    }
  }
}
