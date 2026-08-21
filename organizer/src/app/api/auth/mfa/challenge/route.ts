import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { v2MfaVerify, forwardSetCookies, extractClientContext } from "@/lib/auth/v2-proxy";
import { verifyV2TokenRemote } from "@/lib/auth/v2-token";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * MFA 2차 인증 완료 — login 응답의 mfaToken + TOTP code 를 받아 v2 /auth/mfa/verify 로 검증하고,
 * 성공 시 v2 세션 쿠키를 forward 한다. 이전엔 항상 410 을 반환해 MFA 계정이 로그인 불가했다(P2-C9).
 *
 * 레벨2 2차 D2(잔여): 프로필/앵커를 go DB(users) 조회가 아니라 v2 verify-token 으로 수신한다
 * (login 라우트와 동일 패턴). syncLocalUserFromV2 제거 — go users 무의존.
 */
const schema = z.object({
  mfaToken: z.string().min(1, "MFA 토큰이 없습니다"),
  code: z.string().min(6, "인증 코드를 입력해주세요").max(8),
});

async function challengeHandler(request: Request) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse("요청 본문을 파싱할 수 없습니다", 400);
  }

  let v2Result;
  try {
    v2Result = await v2MfaVerify(
      { mfaToken: body.mfaToken, code: body.code },
      extractClientContext(request),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (msg.includes("HTTP 401") || msg.includes("HTTP 400")) {
      return errorResponse("인증 코드가 올바르지 않거나 만료되었습니다", 401);
    }
    logger.warn("v2 mfa verify 호출 실패", { error: msg });
    return errorResponse("2단계 인증 처리에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
  }

  // v2 verify-token 으로 프로필/앵커 수신(go DB 무의존). 실패 시 500(fail-closed).
  const profile = await verifyV2TokenRemote(v2Result.accessToken);
  if (!profile || !profile.valid || !profile.userId) {
    logger.error("MFA 검증 후 v2 verify-token 실패 — 프로필 미해석", {
      source: "mfa-challenge",
    });
    return errorResponse("사용자 정보를 불러오지 못했습니다", 500);
  }
  // accountId 앵커: go_account_id(=신규는 v2_user_id, 기존은 옛 accounts.id) 우선. login 라우트와 대칭.
  const accountId = profile.goAccountId ?? profile.userId;

  const response = successResponse({
    id: profile.userId,
    accountId,
    email: profile.email ?? "",
    name: profile.name ?? "",
    role: "owner",
  });
  forwardSetCookies(response, v2Result.setCookieHeaders);
  return response;
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "auth:mfa-challenge",
})(challengeHandler);
