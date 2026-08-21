/**
 * 생체 인증 모듈
 *
 * Face ID / 지문 인증을 통한 앱 보안 강화.
 * - 앱 재진입 시 (백그라운드 5분+ → 포그라운드) 생체 인증 요청
 * - 결제 확인 전 생체 인증
 * - 기기 미지원 시 PIN/패턴 폴백 or 스킵
 * - 설정에서 ON/OFF 토글 (기본값: ON)
 */
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import { storage } from "./storage";
import i18n from "@/i18n";

const BIOMETRIC_ENABLED_KEY = "biometric_enabled";
const LAST_AUTH_TIME_KEY = "last_biometric_auth_time";

/** 재인증 필요 간격 (5분) */
const REAUTH_THRESHOLD_MS = 5 * 60 * 1000;

export type BiometricType = "fingerprint" | "facial" | "iris" | "none";

export interface BiometricStatus {
  isAvailable: boolean;
  biometricType: BiometricType;
  isEnrolled: boolean;
}

/** 기기의 생체 인증 지원 상태 확인 */
export async function getBiometricStatus(): Promise<BiometricStatus> {
  try {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    if (!compatible) {
      return { isAvailable: false, biometricType: "none", isEnrolled: false };
    }

    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();

    let biometricType: BiometricType = "none";
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      biometricType = "facial";
    } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      biometricType = "fingerprint";
    } else if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
      biometricType = "iris";
    }

    return { isAvailable: true, biometricType, isEnrolled: enrolled };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return { isAvailable: false, biometricType: "none", isEnrolled: false };
  }
}

/** 생체 인증 활성화 여부 (사용자 설정) */
export async function isBiometricEnabled(): Promise<boolean> {
  const value = await storage.get(BIOMETRIC_ENABLED_KEY);
  // 기본값 ON — 명시적으로 "false"가 저장된 경우만 비활성
  return value !== "false";
}

/** 생체 인증 설정 변경 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await storage.set(BIOMETRIC_ENABLED_KEY, enabled ? "true" : "false");
}

/** 마지막 인증 시간 저장 */
async function setLastAuthTime(): Promise<void> {
  await storage.set(LAST_AUTH_TIME_KEY, Date.now().toString());
}

/** 재인증이 필요한지 확인 (5분 경과 여부) */
export async function needsReauthentication(): Promise<boolean> {
  const enabled = await isBiometricEnabled();
  if (!enabled) return false;

  // 생체 미지원/미등록 시에도 디바이스 자격증명(PIN/패턴)으로 인증 가능하므로
  // 여기서 false를 리턴하면 앱 잠금이 우회된다. authenticate()가 폴백 처리함.
  const lastAuth = await storage.get(LAST_AUTH_TIME_KEY);
  if (!lastAuth) return true;

  const elapsed = Date.now() - parseInt(lastAuth, 10);
  return elapsed > REAUTH_THRESHOLD_MS;
}

/** 디바이스 자격증명(PIN/패턴/비밀번호) 인증 — 생체 하드웨어 없을 때 폴백 */
async function authenticateWithDeviceCredential(
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const t = i18n.t.bind(i18n);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason ?? t("biometric.promptAndroid"),
      cancelLabel: t("biometric.cancel"),
      disableDeviceFallback: false,
    });
    if (result.success) {
      await setLastAuthTime();
      return { success: true };
    }
    return { success: false, error: result.error ?? "authentication_failed" };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : "unknown_error" };
  }
}

/** 생체 인증 실행 */
export async function authenticate(
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const status = await getBiometricStatus();
    if (!status.isAvailable || !status.isEnrolled) {
      // AUDIT §3 P0: fail-open 제거 — 유저가 인증을 활성화했다면 디바이스 자격증명 사용
      const enabled = await isBiometricEnabled();
      if (enabled) return authenticateWithDeviceCredential(reason);
      return { success: true };
    }

    const t = i18n.t.bind(i18n);
    const promptMessage =
      reason ??
      (Platform.OS === "ios"
        ? t("biometric.promptIOS")
        : t("biometric.promptAndroid"));

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: t("biometric.cancel"),
      fallbackLabel: t("biometric.fallback"),
      disableDeviceFallback: false,
    });

    if (result.success) {
      await setLastAuthTime();
      return { success: true };
    }

    return {
      success: false,
      error: result.error ?? "authentication_failed",
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

/**
 * 결제 전 생체 인증
 * 반드시 인증 성공해야 결제 진행 가능
 */
export async function authenticateForPayment(): Promise<{
  success: boolean;
  error?: string;
}> {
  // AUDIT §3 P0: 결제 플로우는 항상 인증 — 생체 없으면 디바이스 자격증명(PIN/패턴) 사용
  const status = await getBiometricStatus();
  if (!status.isAvailable || !status.isEnrolled) {
    return authenticateWithDeviceCredential(i18n.t("biometric.paymentAuth"));
  }

  return authenticate(i18n.t("biometric.paymentAuth"));
}

/**
 * 앱 포그라운드 복귀 시 재인증 체크
 * needsReauthentication() 확인 후 필요 시 authenticate() 호출
 */
export async function checkAndAuthenticate(): Promise<{
  success: boolean;
  error?: string;
}> {
  const needs = await needsReauthentication();
  if (!needs) return { success: true };

  return authenticate();
}
