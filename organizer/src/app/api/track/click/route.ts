/**
 * 이메일 링크 클릭 트래킹 — clicked_at 기록 후 원본 URL 로 302 리다이렉트.
 * 오픈 트래킹 미탐지(픽셀 차단) 시에도 클릭이 있으면 열람으로 간주(opened_at 보정).
 *
 * 원장은 v2 소유(레벨2 컷오버 W5-MSG). messageId 는 메시지 또는 캠페인 id.
 */
import { verifyClickToken } from "@/lib/notification/tracking";
import { recordEmailTracking } from "@/lib/v2/messaging-ledger-client";
import { logger } from "@/lib/logger";

function safeRedirectTarget(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // http/https 만 허용(javascript:, data: 등 오픈 리다이렉트 악용 차단).
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  // ⚠️ H-04: 서명·검증은 raw u(디코딩된 원본 href)로. safeRedirectTarget 은 URL 을 정규화하므로
  // 그 값으로 해시하면 서명(발송 시 원본 href 기준)과 불일치한다.
  const rawTarget = url.searchParams.get("u");
  const target = safeRedirectTarget(rawTarget);

  if (!target) {
    return new Response("잘못된 링크입니다.", { status: 400 });
  }

  // H-04: 토큰이 무효이거나 대상 URL 이 서명된 URL 과 다르면 리다이렉트 금지(오픈 리다이렉트 차단).
  const parsed = rawTarget ? verifyClickToken(token, rawTarget) : null;
  if (!parsed) {
    return new Response("잘못되었거나 만료된 링크입니다.", { status: 400 });
  }

  try {
    await recordEmailTracking(parsed.messageId, parsed.contact, true);
  } catch (err: unknown) {
    // 지표 기록 실패로 수신자의 링크 이동을 막지 않는다.
    logger.warn("클릭 트래킹 기록 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  return Response.redirect(target, 302);
}
