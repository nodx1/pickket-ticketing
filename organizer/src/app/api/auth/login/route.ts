import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { v2Login, forwardSetCookies, extractClientContext, V2AuthError } from "@/lib/auth/v2-proxy";
import { verifyV2TokenRemote } from "@/lib/auth/v2-token";
import { isOrganizerAccount } from "@/lib/auth/resolve-session";
import { NOT_ORGANIZER_CODE, NOT_ORGANIZER_LOGIN_MESSAGE } from "@/lib/auth/not-organizer";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * 로그인 — v2 가 SSOT (레벨2 2차 D2: go DB stub 조회 제거).
 *
 *   1. v2 /api/v1/auth/login 호출 (비번 검증 + MFA 체크 + JWT 발급)
 *   2. v2 verify-token 으로 프로필/앵커(go_account_id/organizer_ref/name/phone) 수신 —
 *      go users 조회를 대체(register stub 제거로 신규 유저는 go users row 가 없음).
 *   3. v2 Set-Cookie 그대로 forward (.pickket.kr SSO)
 *
 * go session/bcrypt/MFA 검증·go DB 조회 모두 제거. v2 단일(accounts/users DROP 선행조건).
 */
const loginSchema = z.object({
  email: z.email("올바른 이메일 형식을 입력해주세요"),
  // max 캡: 초대형 바디(예: 1MB)를 v2 로 forward 하기 전에 400 으로 차단(502 방지).
  password: z.string().min(1, "비밀번호를 입력해주세요").max(200, "비밀번호가 너무 깁니다"),
});

async function loginHandler(request: Request) {
  try {
    const body = loginSchema.parse(await request.json());

    // 1) v2 login — 검증/MFA 모두 v2 가 처리
    let v2Result;
    try {
      // 원본 클라이언트 컨텍스트(UA/IP/언어)를 v2 로 전달 — v2 봇차단/레이트리밋이
      // 최종 사용자 기준으로 동작하게 함 (미전달 시 bot_detected 로 차단됨)
      v2Result = await v2Login(
        { email: body.email, password: body.password },
        extractClientContext(request),
      );
    } catch (err: unknown) {
      if (err instanceof V2AuthError) {
        if (err.status === 401) {
          return errorResponse("이메일 또는 비밀번호가 올바르지 않습니다", 401);
        }
        if (err.status === 423 || err.status === 429) {
          return errorResponse("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.", 423);
        }
        // 그 외 4xx(검증 등)는 원인 메시지를 그대로 노출. 5xx 만 502(Cloudflare HTML화 방지).
        if (err.status >= 400 && err.status < 500) {
          return errorResponse(err.userMessage, 400);
        }
      }
      logger.warn("v2 login 호출 실패", {
        email: body.email,
        error: err instanceof Error ? err.message : "unknown",
      });
      return errorResponse("로그인 처리에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }

    // 1-b) MFA 필요 — 세션 미발급, 클라이언트에 requiresMfa + mfaToken 만 반환(P2-C9).
    //      이전엔 mfa_required 를 버리고 진행해 MFA 우회/로그인 불가가 발생했다.
    if (v2Result.mfaRequired) {
      return successResponse({ requiresMfa: true, mfaToken: v2Result.mfaToken });
    }

    // 2) v2 verify-token 으로 프로필/앵커 수신(go DB 무의존). 실패 시 500(fail-closed).
    const profile = await verifyV2TokenRemote(v2Result.accessToken);
    if (!profile || !profile.valid || !profile.userId) {
      logger.error("로그인 후 v2 verify-token 실패 — 프로필 미해석", {
        source: "login",
        email: body.email,
      });
      return errorResponse("사용자 정보를 불러오지 못했습니다", 500);
    }
    // 주최사가 아닌 계정(피켓 팬 등)은 피켓고 세션을 주지 않는다 — 쿠키를 넘기지 않고 안내만 한다.
    // (넘기면 로그인은 성공한 듯 보이고 대시보드가 다시 로그인 화면으로 돌려보낸다.)
    if (!isOrganizerAccount(profile)) {
      return errorResponse(NOT_ORGANIZER_LOGIN_MESSAGE, 403, NOT_ORGANIZER_CODE);
    }
    // accountId 앵커: go_account_id(=신규는 v2_user_id, 기존은 옛 accounts.id) 우선.
    const accountId = profile.goAccountId ?? profile.userId;

    // 3) v2 cookie forward — go session 발급 안 함
    const response = successResponse({
      id: profile.userId,
      accountId,
      email: profile.email ?? body.email,
      name: profile.name ?? "",
      role: "owner",
    });
    forwardSetCookies(response, v2Result.setCookieHeaders);
    return response;
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    logger.error("[auth/login] 처리 실패", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "auth:login",
})(loginHandler);
