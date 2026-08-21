/**
 * 실명인증 provider factory.
 *
 * 환경변수 IDENTITY_PROVIDER로 선택:
 *  - 'stub' (기본) — 개발/테스트, 고정값 반환
 *  - 'nice' — NICE 표준창 (계약 후 활성)
 *  - 'kcb' — KCB 주민번호대체확인 (계약 후 활성)
 *  - 'pcc' — PCC 본인확인 (계약 후 활성)
 *  - 'toss_cert' — Toss 본인인증 (대안, 계약 후 활성)
 *
 * 실 provider 구현은 각각 별도 파일(nice.ts, kcb.ts 등)에서.
 * 이번 Phase 5B-2 1단계는 인터페이스 + Stub + DB 스키마만.
 * 2단계(벤더 결정 후)에 실 API 호출 구현.
 */
import type { IdentityProvider } from "./types";
import { stubIdentityProvider } from "./stub";
import { logger } from "@/lib/logger";

export function getIdentityProvider(): IdentityProvider {
  const envProvider = (process.env.IDENTITY_PROVIDER ?? "stub").toLowerCase();

  switch (envProvider) {
    case "stub":
      return stubIdentityProvider;
    case "nice":
    case "kcb":
    case "pcc":
    case "toss_cert":
      logger.warn(
        `[identity-factory] IDENTITY_PROVIDER=${envProvider} 지정됐지만 아직 미구현. stub으로 폴백.`,
      );
      return stubIdentityProvider;
    default:
      logger.warn(
        `[identity-factory] 알 수 없는 IDENTITY_PROVIDER='${envProvider}'. stub으로 폴백.`,
      );
      return stubIdentityProvider;
  }
}

export { stubIdentityProvider };
export type {
  IdentityProvider,
  IdentityStartParams,
  IdentityStartResult,
  IdentityCallbackParams,
  IdentityCallbackResult,
} from "./types";
