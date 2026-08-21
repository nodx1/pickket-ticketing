import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { v2Register, forwardSetCookies, extractClientContext, V2AuthError } from "@/lib/auth/v2-proxy";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * 회원가입 — v2 가 SSOT (레벨2 2차 D2: go DB stub 제거).
 *
 *   1. v2 /api/v1/auth/register 호출 — 검증 + 비번 해시 저장 + JWT 발급 +
 *      **OrganizerProfile 멱등 생성**(go_account_id=v2_user_id 앵커). go write-through 앵커를
 *      v2 자체가 세우므로 go accounts/users stub INSERT·pushOrganizerProfileToV2 가 불필요.
 *   2. v2 의 Set-Cookie 그대로 forward (.pickket.kr SSO)
 *
 * go DB(users/accounts) 를 전혀 쓰지 않는다(accounts/users DROP 컷오버 선행조건 충족).
 * session.accountId 는 이후 verify-token 이 반환하는 go_account_id(=v2_user_id)로 채워진다.
 */
const registerSchema = z.object({
  name: z.string().min(2, "이름은 2자 이상이어야 합니다"),
  email: z.email("올바른 이메일 형식을 입력해주세요"),
  phone: z
    .string()
    .regex(/^01[0-9]-?\d{3,4}-?\d{4}$/, "전화번호 형식이 올바르지 않습니다"),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다"),
  passwordConfirm: z.string().min(8, "비밀번호 확인을 입력해주세요"),
});

async function registerHandler(request: Request) {
  try {
    const body = registerSchema.parse(await request.json());
    if (body.password !== body.passwordConfirm) {
      return errorResponse("비밀번호가 서로 일치하지 않습니다", 400);
    }

    // 1) v2 register — v2 가 이메일 중복(EMAIL_ALREADY_EXISTS)·검증·프로필 생성 모두 담당.
    //    go DB 선조회 제거(단일 SoT). 실패하면 go 도 만들 것이 없다.
    let v2Result;
    try {
      v2Result = await v2Register(
        {
          email: body.email,
          password: body.password,
          name: body.name,
          phone: body.phone,
          is_organizer: true,
        },
        extractClientContext(request),
      );
    } catch (err: unknown) {
      logger.error("v2 register 실패 — 가입 중단", {
        email: body.email,
        error: err instanceof Error ? err.message : "unknown",
      });
      // 검증 등 4xx 는 원인 메시지를 사용자에게 그대로 노출(400). 5xx 로 반환하면 Cloudflare 가
      // HTML 에러페이지로 바꿔 "Unexpected token '<'" 로 보이고 진짜 원인이 숨는다.
      if (err instanceof V2AuthError && err.status >= 400 && err.status < 500) {
        return errorResponse(err.userMessage, 400);
      }
      return errorResponse("회원가입 처리에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }

    // 2) go DB 미터치 — v2 register 가 User + 지갑 + OrganizerProfile(go_account_id=v2_user_id)
    //    을 원자적으로 생성한다. go accounts/users stub·pushOrganizerProfileToV2 제거
    //    (accounts/users DROP 컷오버 선행조건). session.accountId 는 이후 verify-token 이
    //    반환하는 go_account_id(=v2_user_id)로 채워진다 → id·accountId 모두 v2_user_id 로 응답.
    const userId = v2Result.v2UserId;
    const accountId = v2Result.v2UserId;

    // 3) v2 cookie 그대로 forward — go session 발급 안 함
    const response = successResponse(
      { id: userId, accountId, email: body.email, name: body.name, role: "owner" },
      201,
    );
    forwardSetCookies(response, v2Result.setCookieHeaders);
    return response;
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.SERVER, 500);
  }
}

export const POST = withRateLimit({
  max: 10,
  windowMs: 60_000,
  keyPrefix: "auth:register",
})(registerHandler);
