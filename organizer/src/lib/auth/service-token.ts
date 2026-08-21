import { timingSafeEqual } from "node:crypto";

/**
 * 내부(플랫폼) 서비스 토큰 검증 — X-Pickket-Service-Token = V2_EVENT_SYNC_SECRET.
 * go↔v2 공유 시크릿(타이밍 세이프 비교). v2 admin 등 내부 호출자 인증에 사용.
 */
export function verifyServiceToken(request: Request): boolean {
  const secret = process.env.V2_EVENT_SYNC_SECRET;
  const provided = request.headers.get("x-pickket-service-token");
  if (!secret || !provided) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
