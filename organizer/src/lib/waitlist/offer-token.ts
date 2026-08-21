/**
 * 대기자 "구매 제안" 딥링크 서명 토큰.
 *
 * 제안(offered) 전이 시 신청자에게 보내는 구매 딥링크에 첨부한다. 토큰은
 *   payload = `${entryId}:${expiresAtMs}:${version}`
 * 를 HMAC-SHA256 서명한 값으로, 위조/탈취·만료·재발송 무효화(version)를 차단한다.
 *
 * - entryId : waitlist_entries.id (전환 대상 고정)
 * - expiresAtMs : 만료 시각(ms) — 토큰 자체에 만료를 임베드(서버가 재확인)
 * - version : waitlist_entries.offer_token_version — 재발송 시 증가시켜 이전 토큰 무효화
 */
import crypto from "node:crypto";
import { resolveNotificationSecret } from "@/lib/notification/secret";

function offerSecret(): string {
  // 전용 WAITLIST_OFFER_SECRET 우선, 없으면 공용 시크릿 폴백(프로덕션 미설정 시 throw).
  return resolveNotificationSecret(
    ["WAITLIST_OFFER_SECRET", "MESSAGE_TRACKING_SECRET", "CRON_SECRET"],
    "pickket-dev-waitlist-offer-secret",
    "대기자 구매 제안 토큰",
  );
}

export interface WaitlistOfferClaims {
  entryId: string;
  expiresAtMs: number;
  version: number;
}

/** 제안 딥링크 토큰 생성. base64url(payload:sig). */
export function makeWaitlistOfferToken(claims: WaitlistOfferClaims): string {
  const payload = `${claims.entryId}:${claims.expiresAtMs}:${claims.version}`;
  const sig = crypto.createHmac("sha256", offerSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/**
 * 토큰 서명 검증. 서명 불일치/포맷 오류 시 null. 만료·version 대조는 호출부가
 * DB 값(offer_token_version, expires_at)과 함께 최종 판정한다(토큰 임베드값은 힌트).
 */
export function verifyWaitlistOfferToken(token: string): WaitlistOfferClaims | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const idx = decoded.lastIndexOf(":");
    if (idx < 0) return null;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = crypto.createHmac("sha256", offerSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    // payload = entryId(UUID):expiresAtMs(숫자):version(숫자) — UUID 에 콜론 없음.
    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    const [entryId, expiresRaw, versionRaw] = parts;
    const expiresAtMs = Number(expiresRaw);
    const version = Number(versionRaw);
    if (!entryId || !Number.isFinite(expiresAtMs) || !Number.isInteger(version)) return null;
    return { entryId, expiresAtMs, version };
  } catch {
    return null;
  }
}
