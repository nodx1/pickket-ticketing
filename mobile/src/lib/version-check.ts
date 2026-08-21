/**
 * 앱 버전 체크 + 강제 업데이트
 *
 * 앱 시작 시 서버에서 최소/권장 버전을 확인하여:
 * - 현재 버전 < 최소 버전 → 강제 업데이트 (앱 사용 불가)
 * - 현재 버전 < 권장 버전 → 업데이트 권장 (닫기 가능)
 * - 그 외 → 정상 진행
 */
import * as Application from "expo-application";
import { Platform, Linking } from "react-native";
import { env } from "@/config/env";
import { api } from "@/config/api";

// TODO(pre-production): App Store 최초 제출 후 실제 App ID로 교체
// App Store Connect → 앱 정보 → Apple ID 확인
const IOS_STORE_URL = "https://apps.apple.com/app/pickket/id000000000";
const ANDROID_STORE_URL = "https://play.google.com/store/apps/details?id=kr.pickket.app";

export type UpdateStatus = "up_to_date" | "update_recommended" | "update_required";

export interface VersionCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  minimumVersion?: string;
  recommendedVersion?: string;
  releaseNotes?: string;
}

interface ServerVersionResponse {
  minimum_version: string;
  recommended_version: string;
  release_notes?: string;
}

/** 시맨틱 버전 비교: a < b → -1, a === b → 0, a > b → 1 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** 현재 앱 버전 가져오기 */
export function getCurrentVersion(): string {
  return Application.nativeApplicationVersion ?? env.APP_VERSION;
}

/** 서버에서 최소/권장 버전 조회 */
async function fetchServerVersion(): Promise<ServerVersionResponse | null> {
  try {
    const response = await api.get<ServerVersionResponse>(
      `/api/v1/app/version`,
      { params: { platform: Platform.OS } },
    );

    return response.data;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // 네트워크 오류 시 업데이트 체크 스킵 (앱 사용 차단 방지)
    return null;
  }
}

/** 버전 체크 실행 */
export async function checkAppVersion(): Promise<VersionCheckResult> {
  const currentVersion = getCurrentVersion();

  const serverVersion = await fetchServerVersion();
  if (!serverVersion) {
    return { status: "up_to_date", currentVersion };
  }

  const { minimum_version, recommended_version, release_notes } = serverVersion;

  // 최소 버전 미달 → 강제 업데이트
  if (compareVersions(currentVersion, minimum_version) < 0) {
    return {
      status: "update_required",
      currentVersion,
      minimumVersion: minimum_version,
      recommendedVersion: recommended_version,
      releaseNotes: release_notes,
    };
  }

  // 권장 버전 미달 → 업데이트 권장
  if (compareVersions(currentVersion, recommended_version) < 0) {
    return {
      status: "update_recommended",
      currentVersion,
      recommendedVersion: recommended_version,
      releaseNotes: release_notes,
    };
  }

  return { status: "up_to_date", currentVersion };
}

/** 앱스토어/플레이스토어 열기 */
export async function openStore(): Promise<boolean> {
  const url = Platform.select({
    ios: IOS_STORE_URL,
    android: ANDROID_STORE_URL,
    default: ANDROID_STORE_URL,
  });

  try {
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) {
      if (__DEV__) console.warn(`[version-check] 스토어 URL을 열 수 없습니다: ${url}`);
      return false;
    }
    await Linking.openURL(url);
    return true;
  } catch (error: unknown) {
    if (__DEV__) console.warn("[version-check] 스토어 열기 실패:", error);
    return false;
  }
}
