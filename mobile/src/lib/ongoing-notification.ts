import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

/**
 * Android 전용 — Live Activity 대신 Ongoing Notification 사용
 * 카운트다운 표시 + 탭 시 앱 열림
 */

const CHANNEL_ID = "ticket-open-countdown";

/** 카운트다운 ongoing notification 시작 */
export async function startOngoingNotification(params: {
  eventId: string;
  title: string;
  body: string;
  color?: string;
}): Promise<string | undefined> {
  if (Platform.OS !== "android") return;

  // 채널 설정
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "티켓오픈 카운트다운",
    importance: Notifications.AndroidImportance.LOW,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: params.title,
      body: params.body,
      sticky: true,
      color: params.color ?? "#FF3366",
      data: { eventId: params.eventId, type: "ticket_open_countdown" },
    },
    trigger: null, // 즉시
  });

  return id;
}

/** Ongoing notification 업데이트 */
export async function updateOngoingNotification(
  notificationId: string,
  _body: string,
): Promise<void> {
  if (Platform.OS !== "android") return;
  // Cancel and recreate (expo-notifications doesn't support update in place)
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

/** Ongoing notification 종료 */
export async function dismissOngoingNotification(
  notificationId: string,
): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.dismissNotificationAsync(notificationId);
}
