import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";

/**
 * 대기자 claim 복구 경보 전용 에스컬레이션 훅(레벨2 재감사 P1).
 *
 * 두 종류의 "복구 보장이 깨지는" 사건을 전용 알림(에러 이슈)으로 승격한다:
 *   - kind:"queue_write_failed" — claim 라우트가 claim-commit 실패 후 복구 큐 INSERT 마저 실패
 *     (recordWaitlistClaimRecovery → recorded:false). 이 경우 converted-미앵커 entry 가 큐에조차 없어
 *     드레인 워커가 영영 손댈 수 없다 = **복구 불가능 상태**. logger.error 만으론 부족 → 반드시 Sentry.
 *   - kind:"manual_review" — 드레인 워커가 재-commit 을 max_attempts 소진/anchor mismatch 로 포기.
 *
 * best-effort: Sentry 미초기화/전송 실패가 라우트·워커 흐름을 절대 막지 않는다(로그만 남기고 삼킴).
 * PII: entryId/orderId/accountId/eventId 만 — 개인정보(이름·연락처)는 넘기지 않는다.
 */
export function alertWaitlistRecovery(input: {
  kind: "queue_write_failed" | "manual_review";
  entryId: string;
  orderId: string;
  accountId?: string | null;
  eventId?: string | null;
  reason: string;
  attempts?: number;
}): void {
  try {
    Sentry.captureMessage(
      `[waitlist] claim 복구 필요 — ${input.kind}: ${input.reason}`,
      {
        level: "error",
        tags: {
          waitlist_alert: input.kind,
          waitlist_reason: input.reason,
        },
        extra: {
          entryId: input.entryId,
          orderId: input.orderId,
          accountId: input.accountId ?? null,
          eventId: input.eventId ?? null,
          attempts: input.attempts ?? null,
        },
      },
    );
  } catch (err: unknown) {
    logger.warn("[waitlist-recovery-alert] Sentry 캡처 실패(무시)", {
      kind: input.kind,
      entryId: input.entryId,
      orderId: input.orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
