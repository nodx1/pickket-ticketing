import { errorResponse, successResponse } from "@/lib/apiResponse";
import { extractWebhookTimestamp, processWebhookPaymentEvent } from "@/lib/payment/webhook";
import { getTossPaymentByOrderId, isTossSecretConfigured } from "@/lib/payment/toss";
import { ensureWebhookOnce, markWebhookResult } from "@/lib/webhook/idempotency";
import { logger } from "@/lib/logger";

/**
 * 토스페이먼츠 웹훅 (PAYMENT_STATUS_CHANGED / DEPOSIT_CALLBACK 등).
 *
 * ⚠️ 토스 웹훅은 HMAC 서명이 없다. 위조 웹훅 차단은 **orderId 로 결제조회 API 재호출**로 한다:
 * 페이로드가 주장하는 결제를 토스 서버에서 직접 조회해 실제 상태(status=DONE)를 확인하고,
 * 조회된 정본 데이터로만 주문을 확정한다. (docs/payments/TOSSPAYMENTS-REFERENCE.md §6)
 */

/** 페이로드에서 orderId 추출 — DEPOSIT_CALLBACK(top-level) / PAYMENT_STATUS_CHANGED(data.orderId) 모두 대응. */
function extractOrderId(payload: Record<string, unknown>): string | null {
  const top = payload.orderId ?? payload.order_id;
  if (typeof top === "string" && top) return top;
  const data = payload.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).orderId ?? (data as Record<string, unknown>).order_id;
    if (typeof nested === "string" && nested) return nested;
  }
  return null;
}

export async function POST(request: Request) {
  const body = await request.text();

  // 1. 페이로드 파싱
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return errorResponse("페이로드 파싱 실패", 400);
  }

  // 2. Idempotency 체크 (Redis NX + DB UNIQUE) — 토스 재시도(최대 7회) 대비 멱등.
  const check = await ensureWebhookOnce({
    provider: "toss",
    rawBody: body,
    parsedPayload: payload,
    timestamp: extractWebhookTimestamp(payload, request.headers),
  });

  if (check.kind === "expired") {
    return errorResponse(`웹훅 타임스탬프 허용 범위 초과 (${check.skewSeconds}초)`, 400);
  }
  if (check.kind === "duplicate") {
    logger.info("[toss-webhook] 중복 웹훅 무시", { eventId: check.eventId, reason: check.reason });
    return successResponse({ received: true, dedup: true, eventId: check.eventId });
  }

  // 3. 조회 재검증 — 정본은 토스 서버. 실 PG 설정 시 orderId 로 조회해 상태를 대조하고,
  //    조회된 결제 객체를 정본 페이로드로 사용한다(위조 웹훅 body 를 신뢰하지 않음).
  let applyPayload: Record<string, unknown> = payload;
  if (isTossSecretConfigured()) {
    const orderId = extractOrderId(payload);
    if (!orderId) {
      await markWebhookResult(check.dbRowId, "ok");
      return successResponse({ received: true, ignored: "no_order_id", eventId: check.eventId });
    }
    let verified: Record<string, unknown> | null;
    try {
      verified = await getTossPaymentByOrderId(orderId);
    } catch (err: unknown) {
      // 조회 장애(네트워크·401·5xx) = fail-closed(P1-10). 위조 검증 불가 → 적용하지 않고
      // 200(토스 재시도 유도). null(미존재)과 달리 장애는 degraded 로 경보한다.
      logger.error("[toss-webhook] 결제조회 장애 — 검증 보류(재시도 유도)", {
        eventId: check.eventId,
        error: err instanceof Error ? err.message : String(err),
      });
      await markWebhookResult(check.dbRowId, "ok");
      return successResponse({ received: true, ignored: "lookup_failed", eventId: check.eventId });
    }
    if (!verified) {
      // 조회 결과 없음(404·미확정) — 적용하지 않고 200 응답(토스 재시도).
      await markWebhookResult(check.dbRowId, "ok");
      return successResponse({ received: true, ignored: "lookup_unverified", eventId: check.eventId });
    }
    applyPayload = verified;
  }

  // 4. 확정 적용 — processWebhookPaymentEvent 가 status(DONE/paid)만 확정하고
  //    가상계좌 '발급'(WAITING_FOR_DEPOSIT)은 무시한다(입금완료 웹훅에서만 확정).
  try {
    const processing = await processWebhookPaymentEvent({
      provider: "toss",
      paymentMethod: "toss",
      payload: applyPayload,
    });
    await markWebhookResult(check.dbRowId, "ok");
    return successResponse({ received: true, eventId: check.eventId, processing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markWebhookResult(check.dbRowId, "error", msg);
    logger.error("[toss-webhook] 처리 실패", { eventId: check.eventId, error: msg });
    return errorResponse("웹훅 처리 실패", 500);
  }
}
