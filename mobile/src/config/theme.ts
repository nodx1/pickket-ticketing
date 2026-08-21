/**
 * Pickket 디자인 토큰
 * 소스: pickket.v2/packages/tailwind-config/globals.css
 * DICE DNA: near-black OLED dark + Pretendard font + neon accent
 */

export const colors = {
  light: {
    background: "#FFFFFF",
    foreground: "#1A1D2E",
    card: "#FFFFFF",
    cardForeground: "#1A1D2E",
    primary: "#1E2A78",
    primaryForeground: "#FFFFFF",
    secondary: "#E8EBFA",
    secondaryForeground: "#1A1D2E",
    muted: "#E8EBFA",
    mutedForeground: "#6B7094",
    accent: "#E8EBFA",
    accentForeground: "#1A1D2E",
    destructive: "#EF4444",
    border: "#D8DCF0",
    input: "#D8DCF0",
    ring: "#1E2A78",
    surface: "#F8F9FC",
    surfaceHover: "#EEF0F8",
    brandHover: "#162060",

    // Pickket 시맨틱
    violet: "#4A5BC4",
    fair: "#00A882",
    fairGlow: "rgba(0, 168, 130, 0.12)",
    hot: "#DC2626",
    hotGlow: "rgba(220, 38, 38, 0.10)",
    warm: "#D97706",
    warning: "#F59E0B",
    success: "#00C9A7",

    // 오버레이
    overlaySubtle: "rgba(0, 0, 0, 0.04)",
    overlayLight: "rgba(0, 0, 0, 0.08)",
    overlayMedium: "rgba(0, 0, 0, 0.15)",
    glass: "rgba(255, 255, 255, 0.85)",
    glassBorder: "rgba(0, 0, 0, 0.06)",
  },
  dark: {
    background: "#0B0B0E",
    foreground: "#F5F5F7",
    card: "#15151A",
    cardForeground: "#F5F5F7",
    primary: "#FF3366",
    primaryForeground: "#FFFFFF",
    secondary: "#1E2240",
    secondaryForeground: "#F5F5F7",
    muted: "#1E2240",
    mutedForeground: "#8E8E93",
    accent: "#1E2240",
    accentForeground: "#F5F5F7",
    destructive: "#FF6B6B",
    border: "rgba(255, 255, 255, 0.08)",
    input: "rgba(255, 255, 255, 0.12)",
    ring: "#FF3366",
    surface: "#15151A",
    surfaceHover: "#1E1E24",
    brandHover: "#E6295C",

    // Pickket 시맨틱
    violet: "#A29BFE",
    fair: "#00D2A0",
    fairGlow: "rgba(0, 210, 160, 0.2)",
    hot: "#FF6B6B",
    hotGlow: "rgba(255, 107, 107, 0.15)",
    warm: "#FFD43B",
    warning: "#FBBF24",
    success: "#00E6BE",

    // 오버레이
    overlaySubtle: "rgba(255, 255, 255, 0.04)",
    overlayLight: "rgba(255, 255, 255, 0.08)",
    overlayMedium: "rgba(255, 255, 255, 0.15)",
    glass: "rgba(20, 20, 24, 0.85)",
    glassBorder: "rgba(255, 255, 255, 0.06)",
  },
} as const;

export const typography = {
  displayLarge: { fontSize: 48, fontFamily: "Pretendard-Black" as const, lineHeight: 54, letterSpacing: -1.5 },
  display: { fontSize: 36, fontFamily: "Pretendard-Black" as const, lineHeight: 42, letterSpacing: -1 },
  numeric: { fontSize: 32, fontFamily: "Pretendard-Bold" as const, fontVariant: ["tabular-nums"] as const },
  h1: { fontSize: 24, fontFamily: "Pretendard-Bold" as const, fontWeight: "700" as const, lineHeight: 32 },
  h2: { fontSize: 20, fontFamily: "Pretendard-Bold" as const, fontWeight: "700" as const, lineHeight: 28 },
  h3: { fontSize: 18, fontFamily: "Pretendard-SemiBold" as const, fontWeight: "600" as const, lineHeight: 26 },
  h4: { fontSize: 16, fontFamily: "Pretendard-SemiBold" as const, fontWeight: "600" as const, lineHeight: 24 },
  h5: { fontSize: 14, fontFamily: "Pretendard-SemiBold" as const, fontWeight: "600" as const, lineHeight: 20 },
  h6: { fontSize: 10, fontFamily: "Pretendard-SemiBold" as const, fontWeight: "600" as const, lineHeight: 14 },
  body: { fontSize: 14, fontFamily: "Pretendard-Regular" as const, fontWeight: "400" as const, lineHeight: 20 },
  bodyLarge: { fontSize: 16, fontFamily: "Pretendard-Regular" as const, fontWeight: "400" as const, lineHeight: 24 },
  bodySmall: { fontSize: 12, fontFamily: "Pretendard-Regular" as const, fontWeight: "400" as const, lineHeight: 16 },
  micro: { fontSize: 10, fontFamily: "Pretendard-Regular" as const, fontWeight: "400" as const, lineHeight: 14 },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  "2xl": 20,
  card: 20,
  cardLg: 24,
  full: 9999,
} as const;

export const buttonHeights = {
  xs: 44,
  sm: 44,
  md: 44,
  lg: 48,
  xl: 52,
} as const;

// 타입 추출
export type ThemeColors = typeof colors.light;
export type ColorScheme = "light" | "dark";
