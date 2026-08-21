import { Share } from "react-native";

// 네이티브 모듈 — dev client 재빌드 필요, graceful fallback
let Sharing: typeof import("expo-sharing") | null = null;
let MediaLibrary: typeof import("expo-media-library") | null = null;
try { Sharing = require("expo-sharing"); // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err: unknown) { /* */ }
try { MediaLibrary = require("expo-media-library"); // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err: unknown) { /* */ }

/**
 * 팬 스탬프 공유 유틸리티
 * Phase 11: Fan Stamp — Photo + Artist Signature + Social Sharing
 */

/** 카메라롤에 저장 */
export async function saveStampToLibrary(uri: string): Promise<boolean> {
  if (!MediaLibrary) return false;
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== "granted") return false;
  await MediaLibrary.saveToLibraryAsync(uri);
  return true;
}

/** 시스템 공유 시트 */
export async function shareStamp(
  uri: string,
  message?: string,
): Promise<void> {
  if (Sharing && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(uri, {
      mimeType: "image/png",
      dialogTitle: message ?? "팬 스탬프 공유",
    });
  } else {
    await Share.share({ url: uri, message: message ?? "" });
  }
}

/** 인스타그램 스토리 공유 (시스템 공유 시트 폴백) */
export async function shareToInstagramStory(
  uri: string,
  _brandColor: string,
): Promise<void> {
  // Instagram Stories API requires native module for UIPasteboard (iOS)
  // For now, use system share sheet which includes Instagram option
  await shareStamp(uri, "내 팬 스탬프 🎫 #pickket");
}

/** 카카오톡 공유 (시스템 공유 시트 폴백) */
export async function shareToKakao(uri: string): Promise<void> {
  await shareStamp(uri);
}

/** 프레임 스타일 정의 */
export const FRAME_STYLES = {
  default: {
    name: "기본",
    borderWidth: 12,
    borderColor: "#FFFFFF",
    borderRadius: 16,
    showInfo: true,
    showWatermark: true,
    filter: undefined,
  },
  neon: {
    name: "네온",
    borderWidth: 3,
    borderColor: undefined, // brandColor 사용
    borderRadius: 16,
    showInfo: true,
    showWatermark: true,
    backgroundColor: "#0B0B0E",
    glowEffect: true,
    filter: undefined,
  },
  vintage: {
    name: "빈티지",
    borderWidth: 16,
    borderColor: "#F5E6D3",
    borderRadius: 4,
    showInfo: true,
    showWatermark: true,
    filter: "sepia",
  },
  minimal: {
    name: "미니멀",
    borderWidth: 0,
    borderColor: undefined,
    borderRadius: 0,
    showInfo: false,
    showWatermark: true, // 우하단 작은 워터마크만
    filter: undefined,
  },
  hologram: {
    name: "홀로그램",
    borderWidth: 4,
    borderColor: undefined,
    borderRadius: 16,
    showInfo: true,
    showWatermark: true,
    backgroundColor: "#0A0A1A",
    glowEffect: true,
    filter: undefined,
  },
  legendary: {
    name: "레전더리",
    borderWidth: 6,
    borderColor: "#FFD700",
    borderRadius: 20,
    showInfo: true,
    showWatermark: true,
    glowEffect: true,
    filter: undefined,
  },
} as const;
