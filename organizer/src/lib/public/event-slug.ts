/**
 * 공개 라우트의 `[eventSlug]` 정규화.
 *
 * 🔴 2026-07-27 prod 실결함: **한글 slug 이벤트의 구매 경로 전체가 404** 였다.
 *
 * slug 는 한글을 허용한다(예: `bc카드한경-제48회-klpga-챔피언십`). 브라우저는 이를
 * percent-encoding 해서 보내는데, Next 의 `params` 가 항상 디코딩된 값을 주지는 않는다.
 * 그래서 v2 by-slug 조회가 **인코딩된 문자열로** 나가 매칭에 실패하고 `null` → `notFound()` 가 된다.
 *
 * 이벤트 상세 페이지(`[eventSlug]/page.tsx`)에는 이 방어가 있었지만 **하위 7개 라우트에는 없었다**:
 *   checkout · checkout/details · checkout/payment · checkout/complete ·
 *   checkout/success · checkout/fail · group-booking
 * ⟹ 상세 페이지는 열리는데 "티켓 구매하기"를 누르면 404 — **판매 경로 전면 차단**이면서
 *    상세가 정상이라 원인을 짐작하기 어렵다(실제로 그렇게 발견됐다).
 *
 * 한 곳에 모아 모든 공개 라우트가 같은 규칙을 쓰게 한다.
 */

/**
 * URL 파라미터 slug → 조회용 slug.
 *
 * 이미 디코딩된 값이 오면 그대로 둔다(이중 디코딩 방지 — `%` 를 포함한 정상 slug 를 깨뜨리지 않는다).
 * 잘못된 인코딩(`decodeURIComponent` 가 던지는 경우)은 원본을 그대로 돌려준다 — 여기서 throw 하면
 * 잘못된 URL 하나가 페이지 전체를 500 으로 만든다(404 로 자연스럽게 떨어지는 편이 낫다).
 */
export function normalizeEventSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
