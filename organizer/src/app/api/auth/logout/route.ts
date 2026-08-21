import { cookies } from "next/headers";
import { successResponse } from "@/lib/apiResponse";
import { PUBLIC_LOOKUP_COOKIE } from "@/lib/public-access";
import { buildForwardHeaders, extractClientContext } from "@/lib/auth/v2-proxy";
import { logger } from "@/lib/logger";

const V2_BASE = process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";

/**
 * 로그아웃 — Phase 2 cutover 후.
 * 1. v2 /api/v1/auth/logout 호출 (refresh token 회전 무효화 + Redis blacklist)
 * 2. go/v2 cookie 모두 만료 처리
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();

  // v2 logout 호출 — refresh token 무효화 (forward 모든 쿠키)
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (cookieHeader) {
    try {
      await fetch(`${V2_BASE}/api/v1/auth/logout`, {
        method: "POST",
        headers: { ...buildForwardHeaders(extractClientContext(request)), Cookie: cookieHeader },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.warn("v2 logout 실패 (cookie 만료는 진행)", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  // 쿠키 만료 — v2 는 REFRESH_COOKIE_DOMAIN(.pickket.kr)으로 도메인 스코프 쿠키를 설정한다.
  // cookieStore.delete(name) 은 host-only 쿠키만 지워서, .pickket.kr 스코프 세션이 남아
  // "로그아웃 안 됨"이 되던 버그(REFRESH_COOKIE_DOMAIN 도입 이후). host-only + 도메인 둘 다 만료.
  const cookieDomain =
    process.env.REFRESH_COOKIE_DOMAIN ||
    process.env.COOKIE_DOMAIN ||
    (process.env.NODE_ENV === "production" ? ".pickket.kr" : "");

  for (const name of [
    "pickket_session", // legacy
    "pickket_role", // legacy
    "pickket_access",
    "pickket_refresh",
    "pickket_csrf",
    "pickket_logged_in",
    PUBLIC_LOOKUP_COOKIE,
  ]) {
    cookieStore.delete(name); // host-only (dev/legacy)
    if (cookieDomain) {
      // 도메인 스코프 쿠키 만료 — 설정 시와 동일한 domain/path 로 maxAge:0.
      cookieStore.set(name, "", {
        maxAge: 0,
        path: "/",
        domain: cookieDomain,
        secure: true,
        sameSite: "lax",
      });
    }
  }

  return successResponse({ loggedOut: true });
}
