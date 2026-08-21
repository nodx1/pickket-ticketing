/**
 * v2 → go webhook HMAC 검증.
 * v2 admin 이 승인/반려 결과를 go 로 보낼 때 사용.
 *
 * 서명 포맷: `{timestamp}.{body}` 를 공유 시크릿으로 HMAC-SHA256.
 * 타임스탬프 freshness: 60초 내.
 *
 * 시크릿: v2 sender 는 `GO_WEBHOOK_SECRET` 으로 서명한다(WEBHOOK_STANDARD).
 * 과거 go 는 `V2_EVENT_SYNC_SECRET` 만 검증했는데, env 이름 불일치 시 전건 401이 났다.
 * → 두 시크릿을 모두 후보로 받아 어느 하나라도 일치하면 통과(전환기 호환).
 */
import crypto from "node:crypto";
import type { NextRequest } from "next/server";

export interface WebhookVerifyResult {
  ok: boolean;
  error?: string;
  eventName?: string;
  deliveryId?: string;
  timestamp?: string;
}

export async function verifyV2Webhook(
  request: NextRequest,
  rawBody: string,
): Promise<WebhookVerifyResult> {
  // v2 sender 는 GO_WEBHOOK_SECRET 으로 서명. 전환기 호환을 위해 V2_EVENT_SYNC_SECRET 도 후보.
  const secrets = [process.env.GO_WEBHOOK_SECRET, process.env.V2_EVENT_SYNC_SECRET].filter(
    (s): s is string => Boolean(s),
  );
  if (secrets.length === 0) {
    return { ok: false, error: "GO_WEBHOOK_SECRET/V2_EVENT_SYNC_SECRET 미설정" };
  }

  const signature = request.headers.get("x-pickket-signature");
  const timestamp = request.headers.get("x-pickket-timestamp");
  const eventName = request.headers.get("x-pickket-event") ?? undefined;
  const deliveryId = request.headers.get("x-pickket-delivery-id") ?? undefined;

  if (!signature || !timestamp || !eventName || !deliveryId) {
    return { ok: false, error: "서명 헤더 누락" };
  }

  // freshness 체크 (60초)
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "잘못된 timestamp" };
  }
  const drift = Math.abs(Date.now() - ts);
  if (drift > 60_000) {
    return { ok: false, error: `timestamp drift ${drift}ms > 60000ms` };
  }

  // HMAC 비교 (constant-time) — 후보 시크릿 중 하나라도 일치하면 통과
  const normalizedSignature = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;
  if (!/^[0-9a-f]{64}$/i.test(normalizedSignature)) {
    return { ok: false, error: "잘못된 서명 형식" };
  }
  const actual = Buffer.from(normalizedSignature, "hex");

  const matched = secrets.some((secret) => {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const exp = Buffer.from(expected, "hex");
    return actual.length === exp.length && crypto.timingSafeEqual(actual, exp);
  });
  if (!matched) {
    return { ok: false, error: "서명 불일치" };
  }

  return { ok: true, eventName, deliveryId, timestamp };
}
