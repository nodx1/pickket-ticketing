/**
 * Stub 실명인증 Provider — 개발/테스트용.
 *
 * NICE/KCB 계약 전 UI 플로우 + DB 스키마 검증에 사용.
 * 실제 인증 없이 콜백 시 고정 값 반환.
 *
 * 활성 방법: IDENTITY_PROVIDER=stub (기본값)
 * 운영 전환: IDENTITY_PROVIDER=nice or kcb (계약 후)
 */
import crypto from "node:crypto";
import type {
  IdentityCallbackParams,
  IdentityCallbackResult,
  IdentityProvider,
  IdentityStartParams,
  IdentityStartResult,
} from "./types";
import { getRuntimeSecret } from "@/lib/env.server";
import { logger } from "@/lib/logger";

export const stubIdentityProvider: IdentityProvider = {
  name: "stub",

  async start(params: IdentityStartParams): Promise<IdentityStartResult> {
    const verificationId = crypto.randomUUID();
    logger.warn("[identity-stub] 실제 인증 없음 — 개발/테스트 모드", {
      purpose: params.purpose,
      verificationId,
    });

    // Stub은 즉시 returnUrl로 돌려보내되 성공 쿼리스트링 추가
    const callbackUrl = new URL(params.returnUrl);
    callbackUrl.searchParams.set("vid", verificationId);
    callbackUrl.searchParams.set("stub", "1");
    callbackUrl.searchParams.set("status", "success");

    return {
      redirectUrl: callbackUrl.toString(),
      verificationId,
      providerMeta: { mode: "stub" },
    };
  },

  async handleCallback(params: IdentityCallbackParams): Promise<IdentityCallbackResult> {
    const callback = params.rawCallback;

    if (callback.stub !== "1" || callback.status !== "success") {
      return {
        success: false,
        rawResponse: callback,
        error: "Stub 콜백 파라미터가 올바르지 않습니다",
      };
    }

    // Stub은 고정된 테스트 사용자 정보 반환
    const testCi = `stub_ci_${params.verificationId}`;
    const testDi = `stub_di_${params.verificationId}`;
    const pepper = getRuntimeSecret("IDENTITY_HASH_PEPPER", "pickket_identity_pepper");

    const ciHash = crypto
      .createHash("sha256")
      .update(testCi + pepper)
      .digest("hex");
    const diHash = crypto
      .createHash("sha256")
      .update(testDi + pepper)
      .digest("hex");
    const nameHash = crypto
      .createHash("sha256")
      .update("테스트사용자" + pepper)
      .digest("hex");

    logger.warn("[identity-stub] 콜백 처리 (stub 고정값)", {
      verificationId: params.verificationId,
    });

    return {
      success: true,
      ciHash,
      diHash,
      nameHash,
      birthYear: 1990,
      gender: "M",
      rawResponse: { ...callback, mode: "stub", note: "stub_fixed_values" },
    };
  },
};
