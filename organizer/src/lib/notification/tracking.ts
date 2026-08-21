/**
 * 이메일 오픈/클릭 실추적 — 트래킹 픽셀(1x1)·링크 래핑 + HMAC 서명 토큰.
 * 가짜지표(임의 오픈율) 대신 실측: 픽셀 히트 → opened_at, 래핑링크 클릭 → clicked_at.
 *
 * 토큰은 (messageId:contact) 를 서명 — 발송 전 조합 가능한 안정 식별자.
 * 수신자별 delivery 행은 발송 후 upsert 되므로, 히트 시 (message_id, channel=email, contact) 로 조회.
 */
import crypto from "node:crypto";
import { resolveNotificationSecret } from "./secret";

// H-05: 프로덕션에서 전용 시크릿(MESSAGE_TRACKING_SECRET) 누락 시 dev 상수로 서명하지 않고 throw.
function trackSecret(): string {
  return resolveNotificationSecret(
    ["MESSAGE_TRACKING_SECRET", "UNSUBSCRIBE_SECRET", "CRON_SECRET"],
    "pickket-dev-tracking-secret",
    "메시지 트래킹 토큰",
  );
}

function baseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "https://go.pickket.kr"
  );
}

export function makeTrackingToken(messageId: string, contact: string): string {
  const payload = `${messageId}:${contact}`;
  const sig = crypto.createHmac("sha256", trackSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

// ── 클릭 토큰: 대상 URL 을 서명에 결합(감사 H-04) ──────────────────────────
// 오픈 픽셀과 달리 클릭 토큰은 목적 URL 해시를 포함해 서명한다. 검증 시 요청 URL 이
// 서명된 URL 과 다르면 실패 → go.pickket.kr 을 통한 오픈 리다이렉트(피싱 중계)를 차단한다.
function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("base64url");
}

export function makeClickToken(messageId: string, contact: string, url: string): string {
  const payload = `${messageId}:${contact}:${urlHash(url)}`;
  const sig = crypto.createHmac("sha256", trackSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

/** 토큰 서명 검증 + URL 바인딩 검증. 둘 중 하나라도 어긋나면 null(리다이렉트 금지). */
export function verifyClickToken(
  token: string,
  url: string,
): { messageId: string; contact: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const idx = decoded.lastIndexOf(":");
    if (idx < 0) return null;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = crypto.createHmac("sha256", trackSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    // payload = messageId:contact:urlHash (messageId=UUID, contact=이메일/숫자, hash=base64url — 콜론 없음)
    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    const [messageId, contact, boundHash] = parts;
    if (!messageId || !contact) return null;
    // URL 바인딩: 요청 URL 해시가 서명된 해시와 일치해야 함.
    const actual = urlHash(url);
    const ha = Buffer.from(boundHash);
    const hb = Buffer.from(actual);
    if (ha.length !== hb.length || !crypto.timingSafeEqual(ha, hb)) return null;
    return { messageId, contact };
  } catch {
    return null;
  }
}

export function verifyTrackingToken(token: string): { messageId: string; contact: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const idx = decoded.lastIndexOf(":");
    if (idx < 0) return null;
    const payload = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 1);
    const expected = crypto.createHmac("sha256", trackSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const sep = payload.indexOf(":");
    const messageId = payload.slice(0, sep);
    const contact = payload.slice(sep + 1);
    return messageId && contact ? { messageId, contact } : null;
  } catch {
    return null;
  }
}

/**
 * 이메일 HTML 에 트래킹 픽셀 주입 + 외부 링크 래핑.
 * - 픽셀: </body> 직전(없으면 말미)에 1x1 이미지.
 * - 링크: http(s) href 를 /api/track/click?u=<enc>&t=<token> 으로 치환(수신거부·mailto 제외).
 */
export function injectEmailTracking(html: string, messageId: string, contact: string): string {
  const openToken = makeTrackingToken(messageId, contact);
  const base = baseUrl();

  // 링크 래핑 — href="http…" (수신거부 링크는 건드리지 않음). 링크마다 URL-바인딩 클릭 토큰 사용.
  const wrapped = html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url: string) => {
    if (url.includes("/api/public/unsubscribe") || url.includes("/api/track/")) return m;
    const clickToken = makeClickToken(messageId, contact, url);
    const wrappedUrl = `${base}/api/track/click?t=${clickToken}&u=${encodeURIComponent(url)}`;
    return `href="${wrappedUrl}"`;
  });

  const pixel = `<img src="${base}/api/track/open?t=${openToken}" width="1" height="1" alt="" style="display:none" />`;
  return /<\/body>/i.test(wrapped)
    ? wrapped.replace(/<\/body>/i, `${pixel}</body>`)
    : `${wrapped}${pixel}`;
}
