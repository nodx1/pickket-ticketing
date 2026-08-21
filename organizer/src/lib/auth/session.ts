/**
 * Session helpers — v2 단일 인증(레벨2 영역D).
 *
 * sessions 테이블이 drop 되므로 createSession/deleteSession 은 no-op.
 * verifySession 은 호환성을 위해 유지하되 v2 cookie 를 읽어 검증(입력 토큰 무시, legacy 호환).
 * 세션 구성은 공용 resolveSessionFromToken 에 위임 — withAuth/getServerSession 과 동일 소스.
 */
import { cookies } from "next/headers";
import { resolveSessionFromToken } from "@/lib/auth/resolve-session";
import { logger } from "@/lib/logger";
import type { User } from "@/lib/types";

/**
 * @deprecated v2 가 세션 발급. go createSession 호출은 더 이상 필요 없음.
 * 호환성 유지를 위해 stub 반환.
 */
export async function createSession(
   
  _userId: string,
   
  _ip?: string,
   
  _userAgent?: string,
): Promise<{ token: string; expiresAt: string }> {
  logger.warn("createSession 호출됨 — Phase 2 후 deprecated. v2 가 세션 처리.");
  return { token: "", expiresAt: new Date(0).toISOString() };
}

/**
 * Cookies 의 pickket_access (v2 access JWT) 를 검증해 User 반환.
 * 입력 token 인자는 호환성용으로 유지하지만 무시됨.
 */
export async function verifySession(

  _token?: string | null,
): Promise<User | null> {
  const c = await cookies();
  const v2Token = c.get("pickket_access")?.value;
  if (!v2Token) return null;
  return resolveSessionFromToken(v2Token);
}

/**
 * @deprecated v2 logout 이 처리. go deleteSession 은 no-op.
 */
export async function deleteSession(
   
  _token: string,
): Promise<void> {
  // sessions 테이블 drop 됨 — 아무 일도 하지 않음
}
