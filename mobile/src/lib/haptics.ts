/**
 * Haptic Feedback 유틸리티
 * 주요 인터랙션(결제, 복권, QR)에서 촉각 피드백 제공
 */
import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

export function light(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function medium(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function success(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}

export function error(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
    () => {},
  );
}

/** 필터 칩 전환 등 미세한 피드백 — iOS는 selection, Android는 light impact */
export async function selectionFeedback(): Promise<void> {
  if (Platform.OS === "ios") {
    await Haptics.selectionAsync();
  } else {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

/** CTA 버튼 프레스 */
export async function impactFeedback(): Promise<void> {
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

/** 즐겨찾기, 레벨업 등 성공 피드백 */
export async function successFeedback(): Promise<void> {
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** 가벼운 탭 피드백 */
export async function lightImpact(): Promise<void> {
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}
