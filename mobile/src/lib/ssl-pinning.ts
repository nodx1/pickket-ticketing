import { Platform } from "react-native";
import { env } from "@/config/env";
import { reportError } from "@/lib/crash-reporting";

/**
 * SSL Certificate Pinning
 *
 * 프로덕션 모바일 빌드에서 `react-native-ssl-public-key-pinning`
 * 네이티브 모듈을 초기화해 실제 SPKI 핀 검증을 적용한다.
 * Expo Go / web / 개발 환경에서는 호스트 allowlist만 검증한다.
 */

type SslPinningModule = typeof import("react-native-ssl-public-key-pinning");

/** 허용된 프로덕션 API 도메인 */
const ALLOWED_HOSTS = [
  "api.pickket.kr",
  "api-stg.pickket.kr",
] as const;

const PIN_EXPIRATION_DATE = "2027-04-13";

/**
 * SHA-256 SPKI 핀 해시 (Base64)
 * 프로덕션 인증서 발급 후 아래 명령어로 추출:
 *   openssl s_client -connect api.pickket.kr:443 | \
 *   openssl x509 -pubkey -noout | \
 *   openssl pkey -pubin -outform der | \
 *   openssl dgst -sha256 -binary | base64
 *
 * 최소 2개 핀 (기본 + 백업) 등록 필수 — 인증서 갱신 시 서비스 중단 방지
 */
// TODO(pre-production): Verify pins match live certificates:
// openssl s_client -connect api.pickket.kr:443 | openssl x509 -pubkey -noout | \
// openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
export const PIN_HASHES: string[] = [
  // api.pickket.kr leaf certificate (2026-04-13 추출)
  "sha256/1wXVsBxnHSrPSkulnetFmk3sTHvC/yx6FbzXPoWR9Ts=",
  // intermediate CA (backup — 인증서 갱신 시 서비스 중단 방지)
  "sha256/iFvwVyJSxnQdyaUvUERIf+8qk7gRze3612JMwoO3zdU=",
];

const NORMALIZED_PIN_HASHES = PIN_HASHES.map((hash) => hash.replace(/^sha256\//, ""));
const PINNING_OPTIONS = Object.fromEntries(
  ALLOWED_HOSTS.map((host) => [
    host,
    {
      includeSubdomains: false,
      publicKeyHashes: NORMALIZED_PIN_HASHES,
      expirationDate: PIN_EXPIRATION_DATE,
    },
  ]),
);

let sslPinningReady = env.IS_DEV || Platform.OS === "web";
let sslPinningInitPromise: Promise<void> | null = null;
let sslPinningListenerRegistered = false;

function getSslPinningModule(): SslPinningModule | null {
  try {
    return require("react-native-ssl-public-key-pinning") as SslPinningModule;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return null;
  }
}

/**
 * 요청 URL이 허용된 호스트인지 검증
 * 개발 환경(localhost/10.0.2.2)과 web은 항상 통과
 */
export function validateRequestHost(url: string): boolean {
  if (env.IS_DEV || Platform.OS === "web") return true;

  try {
    const { hostname, protocol } = new URL(url);

    if (protocol !== "https:") return false;

    return ALLOWED_HOSTS.some((host) => hostname === host);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    return false;
  }
}

export function isSslPinningReady(): boolean {
  return sslPinningReady;
}

/**
 * 프로덕션 모바일 빌드에서 네이티브 핀 검증을 1회 초기화.
 * Expo Go처럼 네이티브 모듈이 없는 런타임은 fail-closed 한다.
 */
export async function ensureSslPinningReady(): Promise<void> {
  if (env.IS_DEV || Platform.OS === "web" || sslPinningReady) return;
  if (sslPinningInitPromise) return sslPinningInitPromise;

  sslPinningInitPromise = (async () => {
    const sslPinning = getSslPinningModule();
    if (!sslPinning) {
      throw new Error("[SSL Pinning] Native module is not installed.");
    }

    if (!sslPinning.isSslPinningAvailable()) {
      throw new Error(
        "[SSL Pinning] Native module unavailable. Use a development or production build instead of Expo Go.",
      );
    }

    if (!sslPinningListenerRegistered) {
      sslPinning.addSslPinningErrorListener((error) => {
        const msg = `[SSL Pinning] Pin validation failed for ${error.serverHostname}: ${error.message ?? "unknown error"}`;
        if (__DEV__) {
          console.error(msg);
        } else {
          reportError(new Error(msg), { tags: { scope: "ssl_pinning" } });
        }
      });
      sslPinningListenerRegistered = true;
    }

    await sslPinning.initializeSslPinning(PINNING_OPTIONS);
    sslPinningReady = true;
  })().catch((error) => {
    sslPinningReady = false;
    sslPinningInitPromise = null;
    throw error;
  });

  return sslPinningInitPromise;
}

/**
 * Axios 요청 인터셉터용 — 비허용 호스트 차단 + 프로덕션 모바일 핀 초기화
 */
export async function assertTrustedHost(url: string | undefined): Promise<void> {
  if (!url || env.IS_DEV) return;

  if (!validateRequestHost(url)) {
    throw new Error(
      `[SSL Pinning] Untrusted host: ${url}. Only HTTPS requests to ${ALLOWED_HOSTS.join(", ")} are allowed.`,
    );
  }

  await ensureSslPinningReady();

  if (!isSslPinningReady()) {
    throw new Error("[SSL Pinning] Native SSL pinning is not active.");
  }
}

/**
 * SSL 핀 만료일까지 남은 일수와 경고 여부를 반환.
 * 앱 시작 시 호출하여 만료 60일 전부터 Sentry/콘솔 경고.
 */
export function checkPinExpiry(): { daysUntilExpiry: number; isWarning: boolean } {
  const expiry = new Date(PIN_EXPIRATION_DATE);
  const days = Math.floor((expiry.getTime() - Date.now()) / 86400000);
  return { daysUntilExpiry: days, isWarning: days < 60 };
}
