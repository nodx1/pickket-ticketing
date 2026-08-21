/**
 * 행사 페이지 경로 만들기 — **순수 모듈**.
 *
 * ## 🔴 왜 함수인가 (2026-08-01)
 * 착지 화면(환불완료·예약내역)에서 행사로 돌아가는 길을 넣으면서, 슬러그를 그대로
 * 템플릿에 끼우면 두 가지가 조용히 터진다.
 *
 * ① **`/e/undefined`** — 환불 화면은 `/my-tickets/[ticketNumber]/refund` 라 슬러그를 모른다.
 *    v2 티켓 응답의 `event` 에도 slug 가 **없다**(`event_id`·`title`·`venue` 뿐).
 *    없는 값을 문자열로 이어붙이면 `undefined` 가 경로에 박혀 404 로 간다.
 *    ⟹ 없으면 **버튼을 안 만든다**(`null` 을 돌려준다). 깨진 링크보다 없는 링크가 낫다.
 *
 * ② **한글 슬러그** — 이 대회 슬러그가 `bc카드한경-klpga-챔피언십` 이다.
 *    인코딩하지 않으면 클라이언트 라우팅에서 매칭이 어긋난다(2026-07-27 에 같은 원인으로
 *    **구매 경로 전체가 404** 였다 — `event-slug.ts` 참조).
 */

/**
 * `/e/{slug}` 경로. 슬러그가 없으면 **`null`** — 호출측은 버튼을 그리지 않는다.
 *
 * ⚠️ `"undefined"`·`"null"` 같은 문자열도 없는 것으로 본다. 상위에서 값이 유실되면
 *    그 모양으로 흘러들어오는데, 그대로 링크를 만들면 404 페이지로 손님을 보낸다.
 */
export function eventPagePath(slug: string | null | undefined): string | null {
  const trimmed = typeof slug === "string" ? slug.trim() : "";
  if (!trimmed || trimmed === "undefined" || trimmed === "null") return null;
  return `/e/${encodeURIComponent(trimmed)}`;
}
