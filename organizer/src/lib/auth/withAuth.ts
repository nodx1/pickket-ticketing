/**
 * 인증 미들웨어 — v2 토큰 단일(레벨2 영역D 재배선).
 *
 * 1. cookie `pickket_access` (v2 access JWT) 또는 Authorization: Bearer 헤더
 * 2. go 자체 HMAC verify (V2_JWT_SECRET) → payload.sub(=v2_user_id) 추출
 * 3. 공용 resolveSessionFromToken 으로 세션 구성(session.v2UserId = JWT sub 앵커 포함)
 *
 * 세션 구성 로직은 resolve-session.ts 단일 소스에 위임 — server-session/session 과 공유.
 * (아직 go users 프로필을 읽는 이유는 resolve-session.ts 주석 참조: write-through 가
 *  session.accountId=go accounts.id 를 요구하기 때문. 1차 경계.)
 */
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { resolveSessionFromToken } from "@/lib/auth/resolve-session";
import { logger } from "@/lib/logger";
import { getRequestContext } from "@/lib/request-context";
import type { User } from "@/lib/types";

export interface AuthContext<TParams = unknown> {
  session: User;
  params: TParams;
}

type Handler<TParams> = (
  request: NextRequest,
  context: AuthContext<TParams>,
) => Promise<Response>;

export function withAuth<TParams = unknown>(handler: Handler<TParams>) {
  return async (request: NextRequest, context: { params: Promise<TParams> }) => {
    const cookieStore = await cookies();
    const v2AccessToken = cookieStore.get("pickket_access")?.value ?? null;
    const authHeader = request.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
    const token = v2AccessToken ?? bearerToken;

    if (!token) {
      return errorResponse(ERR.UNAUTHORIZED, 401);
    }

    try {
      const session = await resolveSessionFromToken(token);
      if (!session) {
        return errorResponse(ERR.UNAUTHORIZED, 401);
      }

      return handler(request, {
        session,
        params: await context.params,
      });
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error("인증 처리 실패", {
          source: "withAuth",
          error: err.message,
          ...getRequestContext(request),
        });
      }
      return errorResponse(ERR.SERVER, 500);
    }
  };
}
