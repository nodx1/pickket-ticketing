/**
 * 서버 컴포넌트/라우트에서 현재 로그인 사용자 조회.
 *
 * v2 JWT(pickket_access) cookie 기반 단일 검증. 세션 구성은 공용 resolveSessionFromToken
 * 에 위임(withAuth/verifySession 과 동일 소스). 인증 안 된 경우 null 반환.
 */
import { cookies } from "next/headers";
import { resolveSessionFromToken } from "@/lib/auth/resolve-session";
import type { User } from "@/lib/types";

export async function getServerSession(): Promise<User | null> {
  const c = await cookies();
  const v2Token = c.get("pickket_access")?.value;
  if (!v2Token) return null;
  return resolveSessionFromToken(v2Token);
}
