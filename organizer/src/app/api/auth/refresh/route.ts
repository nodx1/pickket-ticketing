import { NextResponse } from "next/server";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logger } from "@/lib/logger";
import { forwardSetCookies, buildForwardHeaders, extractClientContext } from "@/lib/auth/v2-proxy";

const V2_BASE = process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";

/**
 * access 토큰 (15분) 만료 시 refresh 토큰 (7일) 으로 자동 갱신.
 *
 * 클라이언트 (fetchWithAuth 등) 가 401 받으면 이 endpoint 호출 → 성공 시 원 요청 재시도.
 * v2 가 새 access + refresh cookie 를 Set-Cookie 로 내려주면 그대로 forward.
 */
export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (!cookieHeader.includes("pickket_refresh=")) {
    return errorResponse("refresh token 없음", 401);
  }

  try {
    const res = await fetch(`${V2_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      // 클라이언트 컨텍스트(UA/IP) 전달 + refresh 쿠키 — v2 봇차단 회피
      headers: { ...buildForwardHeaders(extractClientContext(request)), Cookie: cookieHeader },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn("v2 refresh 실패", { status: res.status, body: text.slice(0, 200) });
      return errorResponse("세션 갱신 실패. 다시 로그인해주세요.", 401);
    }

    const response = successResponse({ refreshed: true });
    type ExtendedHeaders = Headers & { getSetCookie?: () => string[] };
    const h = res.headers as ExtendedHeaders;
    const cookies = typeof h.getSetCookie === "function"
      ? h.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    forwardSetCookies(response as unknown as NextResponse, cookies);
    return response;
  } catch (err: unknown) {
    logger.warn("auth/refresh 에러", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return errorResponse("세션 갱신에 실패했습니다", 500);
  }
}
