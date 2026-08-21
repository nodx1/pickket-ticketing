import type { RefundRule } from "@/lib/refund/calculator";
import { V2CommerceError, getRefundPolicy, putRefundPolicy, deleteRefundPolicy } from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";

/**
 * 이벤트별 커스텀 환불 규칙 — 레벨2 컷오버 **W5-COMMERCE**.
 *
 * 환불 예상액 표시(주문상세)와 실제 환불 적용(refund API)의 SSOT.
 *
 * ## 배경(감사 P0-6)
 * 주문상세 화면은 `calculateRefund` 를 기본규칙으로만 호출했고(customRules 미전달),
 * refund API 는 커스텀 규칙을 반영했다 → 커스텀 정책이 있으면 표시액≠실제 처리액(금전 오안내).
 * 두 경로가 이 헬퍼로 동일 rules 를 조회해 표시=적용 일치를 보장한다.
 *
 * ## ⚠️ go 시절 이 기능은 반쪽이었다
 * go `refund_policies` 는 **SELECT 만 있고 writer 가 0**이었다 — 손으로 DB 를 만지지 않는 한
 * 커스텀 정책은 생길 수 없었고, 실질적으로 언제나 기본규칙(`calculator.defaultRules`)이었다.
 * v2 이관과 함께 `saveEventRefundRules` / `clearEventRefundRules` 로 **저장 경로를 신설**한다.
 *
 * ## 🔴 실패를 흡수하지 않는다
 * 옛 구현은 조회 결과가 없으면 `undefined`(= 기본규칙)를 돌려줬는데, 조회가 **실패**했을 때도
 * 같은 값이 나갈 수 있었다. "커스텀 정책 없음"과 "정책을 못 읽음"은 완전히 다른 사실이고,
 * 후자를 전자로 뭉개면 커스텀 정책 이벤트에서 표시액과 실제 환불액이 갈라진다.
 * 이 모듈은 실패를 **던진다**(`EventAccessError` / `V2CommerceError`) — 호출측이 503 으로 끊는다.
 */

/**
 * 이벤트의 커스텀 환불 규칙 조회.
 *
 * @returns 커스텀 규칙 배열. **미등록이면 `undefined`**(→ `calculateRefund` 가 기본규칙 사용).
 * @throws EventAccessError 미소유/미존재(404) 또는 v2 장애(503).
 * @throws V2CommerceError  v2 정책 조회 실패.
 */
/**
 * 환불 계산용 이벤트 조회 — **소유 경계를 그대로 통과시킨 뒤** 정책 원본을 돌려준다.
 *
 * 🔴 왜 `getEventRefundRules` 대신 이걸 쓰는가 (2026-07-31)
 * 그 함수는 v2 `event_refund_policies` 를 읽는데, **거기에 쓰는 화면이 존재하지 않는다**
 * (prod 실측 0행). 그래서 항상 `undefined` 를 돌려줬고 환불은 하드코딩 기본값으로 나갔다.
 * 주최자가 대시보드에서 저장하는 곳은 `events.cancellation_fee_tiers` 다 — 그쪽을 읽어야
 * "설정한 대로 환불" 이 성립한다.
 *
 * ⚠️ `getEventRefundRules`/`saveEventRefundRules` 는 아직 남겨둔다(별건 정리 대상).
 *    지금 지우면 그 함수를 쓰는 다른 표시 경로가 같이 죽는다.
 *
 * @throws EventAccessError 미소유/미존재(404) 또는 v2 장애(503).
 */
export async function getEventForRefund(
  accountId: string,
  eventId: string,
): Promise<{ cancellation_fee_tiers?: Array<{ days_before: number; fee_pct: number }> | null }> {
  return requireOwnedEvent(eventId, accountId);
}

export async function getEventRefundRules(
  accountId: string,
  eventId: string,
): Promise<RefundRule[] | undefined> {
  // 소유 경계는 v2 organizer_ref 가 강제한다(타 계정 이벤트 → 404 → EventAccessError).
  const event = await requireOwnedEvent(eventId, accountId);
  const { policy } = await getRefundPolicy(event.event_id);
  if (!policy || policy.rules.length === 0) return undefined;
  return policy.rules;
}

/**
 * 커스텀 환불 규칙 저장(upsert) — **go 에 없던 write 경로**.
 *
 * @throws EventAccessError · V2CommerceError (400=규칙 형식 위반, 5xx=저장 실패)
 */
export async function saveEventRefundRules(
  accountId: string,
  eventId: string,
  input: { title: string; description?: string | null; rules: RefundRule[] },
): Promise<RefundRule[]> {
  const event = await requireOwnedEvent(eventId, accountId);
  const saved = await putRefundPolicy(event.event_id, {
    title: input.title,
    description: input.description ?? null,
    refund_type: "partial",
    rules: input.rules,
  });
  return saved.rules;
}

/**
 * 커스텀 환불 규칙 제거 → 기본규칙 복귀.
 *
 * @returns 제거 여부. 커스텀 정책이 애초에 없었으면 `false`(v2 404).
 * @throws EventAccessError · V2CommerceError (v2 장애 — "이미 없음"으로 흡수하지 않는다)
 */
export async function clearEventRefundRules(
  accountId: string,
  eventId: string,
): Promise<boolean> {
  const event = await requireOwnedEvent(eventId, accountId);
  try {
    await deleteRefundPolicy(event.event_id);
    return true;
  } catch (err: unknown) {
    // 404 만 "커스텀 정책 없음"으로 해석한다. 5xx/타임아웃은 그대로 던져 503 이 되게 한다.
    if (err instanceof V2CommerceError && err.status === 404) return false;
    throw err;
  }
}

/** 환불 규칙 조회 실패를 상태코드로 옮긴다. 미소유/미존재 404 · 그 외 503. */
export function refundPolicyErrorStatus(err: unknown): 404 | 503 | null {
  if (err instanceof EventAccessError) return err.reason === "not_found" ? 404 : 503;
  if (err instanceof V2CommerceError) return err.status === 404 ? 404 : 503;
  return null;
}
