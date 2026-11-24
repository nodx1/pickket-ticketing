/**
 * 서버 컴포넌트/라우트에서 현재 로그인 사용자 조회.
 *
 * v2 JWT(pickket_access) cookie 기반 단일 검증. 세션 구성은 공용 resolveSessionFromToken
 * 에 위임(withAuth/verifySession 과 동일 소스). 인증 안 된 경우 null 반환.
 */
import { cookies } from "next/headers";
import { resolveSessionFromToken, resolveSessionResult, type SessionResult } from "@/lib/auth/resolve-session";
import type { User } from "@/lib/types";

export async function getServerSession(): Promise<User | null> {
  const c = await cookies();
  const v2Token = c.get("pickket_access")?.value;
  if (!v2Token) return null;
  return resolveSessionFromToken(v2Token);
}

/** getServerSession 과 같지만 실패 이유(토큰 없음·무효 = invalid, 주최사 아님 = not_organizer)를 준다. */
export async function getServerSessionResult(): Promise<SessionResult> {
  const c = await cookies();
  const v2Token = c.get("pickket_access")?.value;
  if (!v2Token) return { session: null, failure: "invalid" };
  return resolveSessionResult(v2Token);
}
