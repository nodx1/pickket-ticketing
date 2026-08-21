import { useColorScheme } from "react-native";
import {
  colors,
  typography,
  spacing,
  radius,
  buttonHeights,
  type ColorScheme,
} from "@/config/theme";

/**
 * 테마 훅 — 시스템 설정 기반 다크/라이트 모드.
 * forceDark / forceLight 옵션으로 특정 화면에서 강제 지정 가능.
 */
export function useTheme(options?: { forceLight?: boolean; forceDark?: boolean }) {
  const systemScheme = useColorScheme();
  const scheme: ColorScheme = options?.forceLight
    ? "light"
    : options?.forceDark
      ? "dark"
      : (systemScheme ?? "dark");

  return {
    scheme,
    colors: colors[scheme],
    typography,
    spacing,
    radius,
    buttonHeights,
    isDark: scheme === "dark",
  };
}
