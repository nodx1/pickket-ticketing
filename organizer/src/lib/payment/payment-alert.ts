import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";

/**
 * 결제 경보 전용 에스컬레이션 훅(레벨2 재감사 P1).
 *
 * manual_review 는 "실결제인데 v2 매출 미확정" 또는 "PG 캡처인데 go 미투영" 같은 **실돈 불일치**라
 * logger.error 만으론 부족하다. 여기서 Sentry 로 명시 캡처해 전용 알림(에러 이슈)으로 승격한다.
 *
 * best-effort: Sentry 미초기화/전송 실패가 워커/라우트 흐름을 절대 막지 않는다(로그만 남기고 삼킴).
 * PII: orderId/v2OrderId/amount 만 태그로 — 개인정보는 넘기지 않는다.
 */
export function alertPaymentManualReview(input: {
  // confirm_outbox_sweep = 드레인 루프 밖 sweep 격리분. 루프 알림에 도달하지 못하는
  //   경로라 따로 구분한다(2026-07-30 — 종전엔 건수·알림 모두 없었다).
  source: "confirm_outbox" | "confirm_outbox_sweep" | "compensation" | "orphan_toss";
  orderId: string;
  v2OrderId?: string | null;
  amount?: number;
  reason: string;
  attempts?: number;
}): void {
  try {
    Sentry.captureMessage(`[payment] manual_review 필요 — ${input.source}: ${input.reason}`, {
      level: "error",
      tags: {
        payment_alert: "manual_review",
        payment_source: input.source,
        payment_reason: input.reason,
      },
      extra: {
        orderId: input.orderId,
        v2OrderId: input.v2OrderId ?? null,
        amount: input.amount ?? null,
        attempts: input.attempts ?? null,
      },
    });
  } catch (err: unknown) {
    logger.warn("[payment-alert] Sentry 캡처 실패(무시)", {
      source: input.source,
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
