import { Platform, StatusBar } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";

/**
 * 화면별 StatusBar 스타일 설정 훅
 * Android에서는 투명 배경 + translucent 자동 적용
 */
export function useStatusBarStyle(
  style: "light-content" | "dark-content",
) {
  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle(style);
      if (Platform.OS === "android") {
        StatusBar.setBackgroundColor("transparent");
        StatusBar.setTranslucent(true);
      }
    }, [style]),
  );
}
