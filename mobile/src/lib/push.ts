/**
 * Expo Push 등록 유틸
 */
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { registerPushToken, unregisterPushToken } from "@/config/api";
import i18n from "@/i18n";

// AUDIT 2026-04-20 §14 P0: 앱 foreground 상태에서 알림이 iOS에 표시되지 않던 문제 해결.
// 모듈 로드 시 1회 등록 — app/_layout.tsx가 push 모듈을 import하므로 부트 시점에 적용.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/** Expo Push Token 등록 + 서버 전송 */
export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    // 에뮬레이터에서는 푸시 불가
    return null;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const tokenData = await Notifications.getExpoPushTokenAsync();
  const token = tokenData.data;

  // 서버에 토큰 등록
  try {
    await registerPushToken(token);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // 서버 등록 실패해도 로컬 토큰은 반환
  }

  // Android 알림 채널 설정
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: i18n.t("push.defaultChannel"),
      importance: Notifications.AndroidImportance.MAX,
    });
  }

  return token;
}

/** 푸시 해제 */
export async function unregisterPush(token: string): Promise<void> {
  try {
    await unregisterPushToken(token);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // 실패해도 무시
  }
}
