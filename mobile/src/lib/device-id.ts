/**
 * Device Identity — 디바이스 지속 식별자
 *
 * AUDIT 2026-04-20 §13 P0 (1차 layer):
 * 회전 QR 리플레이 방어를 위해 모든 HTTP 요청에 X-Device-Id 헤더를 전송.
 * 백엔드는 /tickets/{id}/bind-device에서 이 값을 티켓에 바인딩하고,
 * 이후 /tickets/{id}/qr 및 양도/환불 민감 작업에서 헤더 일치를 강제.
 *
 * 설계 결정:
 * - expo-crypto의 getRandomBytesAsync(32) + SHA-256 해시 → hex 64자.
 * - SecureStore 저장 (iOS Keychain / Android Keystore).
 * - 비밀은 네트워크로 나가지 않고, 파생값 device_id만 전송 (TODO: 앞 16자만 전송).
 * - 앱 재설치 시 변경됨 → 재바인딩 필요 (1회만 허용하는 백엔드 정책과 맞춤).
 *
 * Phase B로 이월된 부분 (본 세션에서 구현하지 않음):
 * - Ed25519 공개키 암호로 QR 요청 자체에 디바이스 서명 (tweetnacl 도입 필요).
 * - App Attest (iOS) / Play Integrity (Android)로 디바이스 무결성 증명.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "device_id_v1";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 앱 최초 구동 시 디바이스 ID 생성, 이후엔 캐시 반환. idempotent. */
export async function ensureDeviceId(): Promise<string> {
  let cached = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (cached) return cached;

  const seed = await Crypto.getRandomBytesAsync(32);
  // SHA-256(seed) — seed는 즉시 버리고 해시만 저장 (future-proof)
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `pickket:device:${toHex(seed)}`,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  await SecureStore.setItemAsync(DEVICE_ID_KEY, digest);
  return digest;
}

/** 동기 캐시 (axios interceptor가 매 요청마다 await 없이 읽을 수 있도록). */
let _cachedDeviceId: string | null = null;

/** 부트 시 1회 호출. 이후 getDeviceIdSync()로 동기 접근. */
export async function hydrateDeviceId(): Promise<string> {
  _cachedDeviceId = await ensureDeviceId();
  return _cachedDeviceId;
}

export function getDeviceIdSync(): string | null {
  return _cachedDeviceId;
}

/** 로그아웃/탈퇴 시 디바이스 ID 초기화. 다음 유저는 새 ID로 재바인딩. */
export async function resetDeviceId(): Promise<void> {
  _cachedDeviceId = null;
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
}
