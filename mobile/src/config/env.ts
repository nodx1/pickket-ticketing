import Constants from "expo-constants";
import { Platform } from "react-native";

const extra = Constants.expoConfig?.extra ?? {};

function resolveApiUrl(): string {
  // 개발 환경: 플랫폼별 localhost 매핑 (Android 에뮬레이터는 10.0.2.2 필요)
  if (__DEV__) {
    return Platform.select({
      android: "http://10.0.2.2:8021",
      ios: "http://localhost:8021",
      default: "http://localhost:8021",
    }) ?? "http://localhost:8021";
  }

  // 프로덕션: EAS build env → extra → 기본값
  return process.env.EXPO_PUBLIC_API_URL ?? extra.apiUrl ?? "https://api.pickket.kr";
}

// 결제는 웹 체크아웃(토스 결제위젯)을 WebView 로 로드하므로 모바일 자체 PG 키는 불필요.
const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? extra.sentryDsn ?? "";

// AUDIT 2026-04-20 §18 P0: REPLACE_ placeholder 또는 empty 값이 프로덕션 빌드에 주입되면 즉시 실패.
// 과거 eas.json에 "REPLACE_WITH_..." 문자열이 literal로 전달되어 외부 SDK init 실패 이력 있음.
function assertProdSecret(name: string, value: string): string {
  if (__DEV__) return value;
  if (!value || value.startsWith("REPLACE_")) {
    throw new Error(
      `[env] Production build missing secret: ${name}. ` +
        `Use 'eas secret:create --scope project --name ${name}' to provide the value.`,
    );
  }
  return value;
}

const SENTRY_DSN = assertProdSecret("EXPO_PUBLIC_SENTRY_DSN", sentryDsn);

export const env = {
  API_URL: resolveApiUrl(),
  IS_DEV: __DEV__,
  APP_VERSION: Constants.expoConfig?.version ?? "0.0.0",
  EAS_PROJECT_ID: extra.eas?.projectId ?? "",
  SENTRY_DSN,
} as const;
