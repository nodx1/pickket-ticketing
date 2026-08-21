/**
 * 이메일 오픈 트래킹 픽셀 — 1x1 GIF 반환 + opened_at 기록(최초 1회).
 * 인증 없음(공개). 토큰 위조 방지는 HMAC 서명으로.
 *
 * 원장은 v2 소유(레벨2 컷오버 W5-MSG). messageId 는 event_messages.id 또는
 * email_campaigns.id — v2 가 양쪽 모두 시도해 해당하는 쪽만 갱신한다.
 */
import { verifyTrackingToken } from "@/lib/notification/tracking";
import { recordEmailTracking } from "@/lib/v2/messaging-ledger-client";
import { logger } from "@/lib/logger";

// 투명 1x1 GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixelResponse(): Response {
  return new Response(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Content-Length": String(PIXEL.length),
    },
  });
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const parsed = verifyTrackingToken(token);
  if (parsed) {
    try {
      await recordEmailTracking(parsed.messageId, parsed.contact, false);
    } catch (err: unknown) {
      // 트래킹 실패는 메일 렌더를 깨뜨리지 않는다(지표 손실 < 화면 파손). 로그로만 남긴다.
      logger.warn("오픈 트래킹 기록 실패", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  // 기록 성공/실패와 무관하게 항상 픽셀 반환(메일 렌더 깨짐 방지).
  return pixelResponse();
}
