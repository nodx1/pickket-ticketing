import { z } from "zod";

/**
 * 환불 수수료 단계 입력 스키마 — **라우트와 테스트가 같은 객체를 쓴다.**
 *
 * 🔴 왜 파일을 나누나 (2026-07-31 자체 검수)
 * 처음엔 이 규칙을 `api/events/[eventId]/route.ts` 안에 두고, 테스트에서 **같은 규칙을
 * 손으로 다시 만들어** 검사했다. 그러면 라우트를 고쳐도 테스트는 자기 복제본을 보고
 * 계속 초록이다 — 오늘 다른 세션의 `repair-sql-pg.sql`(손 복제본) 을 같은 이유로
 * 지적해놓고 내가 똑같이 했다.
 *
 * ## 규칙이 이렇게 생긴 이유
 *  · `.min(1)`  빈 배열을 저장하면 v2 `internal_commerce.py` 가 `tiers or None` 으로
 *               **NULL** 을 넣고, NULL 이면 `refund_service.py` 가 **플랫폼 기본단계**를
 *               적용한다. 공개 화면엔 "환불 규정이 설정되지 않았습니다" 인데 **돈은 깎인다.**
 *  · `.max(6)`  구매 패널의 환불 카드가 무너져 구매자가 규정을 못 읽는다.
 *  · 중복 금지   같은 경계에 두 수수료 → 어느 쪽이 약속인지 알 수 없다.
 *               공개 상세가 `key={line.label}` 을 쓰므로 React key 충돌까지 난다.
 */
export const MAX_CANCELLATION_TIERS = 6;

export const cancellationTiersSchema = z
  .array(
    z.object({
      daysBefore: z.number().int().min(0),
      feePct: z.number().min(0).max(100),
    }),
  )
  .min(1, "환불 규정은 최소 1단계가 필요합니다")
  .max(MAX_CANCELLATION_TIERS, `환불 규정은 최대 ${MAX_CANCELLATION_TIERS}단계까지 설정할 수 있습니다`)
  .refine((tiers) => new Set(tiers.map((t) => t.daysBefore)).size === tiers.length, {
    message: "같은 '일 전' 값을 두 번 쓸 수 없습니다",
  });
