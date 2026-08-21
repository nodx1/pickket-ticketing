/**
 * 행사 소개 본문 — **순수 모듈**.
 *
 * ## 🔴 판매 중인 행사에 「준비 중입니다」가 떠 있었다 (2026-08-01 대표 지적)
 *
 * 공개 상세의 「이벤트 안내」 자리가 이랬다:
 *
 *     {String(event.description ?? event.summary ?? "이벤트 소개가 준비 중입니다.")}
 *
 * 주최자가 소개글을 안 넣으면 **손님에게 "준비 중" 이라고 말한다.** 그런데 바로 아래
 * 안내 이미지(대회 개요·티켓·갤러리)에 내용이 다 들어 있다 — 준비가 안 된 게 아니라
 * **글 대신 이미지로 넣은 것**이다. 티켓을 파는 중인 페이지가 스스로 미완성이라고
 * 광고하는 꼴이라, 사려던 사람이 망설인다.
 *
 * ## 🔴 그리고 `??` 는 빈 문자열을 못 거른다
 *
 *     "" ?? "기본값"   →  ""      (null·undefined 일 때만 넘어간다)
 *
 * 소개글을 **지웠을 때** 저장되는 값이 정확히 `""` 다. 그러면 폴백도 안 타고
 * **빈 문단**이 남아 여백만 벌어진다. 공백만 넣은 경우도 마찬가지다.
 * (v2 가 `null` PATCH 를 무시해 지우기가 공백 한 칸으로 처리되던 이력도 있다.)
 *
 * ⟹ 비어 있음의 판정을 **한 곳**에서 하고, 없으면 **아무것도 그리지 않는다.**
 */

/**
 * 소개 본문을 고른다. 없으면 `null`.
 *
 * ⚠️ `null` 은 "그리지 말라" 는 뜻이다 — 대체 문구를 지어내지 않는다.
 *    무엇을 대신 보여줄지는 호출부가 정한다(이미지가 있으면 그것으로 충분하다).
 */
export function resolveIntroText(
  description: unknown,
  summary: unknown,
): string | null {
  for (const candidate of [description, summary]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return candidate; // 원문 그대로 — 줄바꿈·들여쓰기를 보존한다
  }
  return null;
}

/**
 * 「이벤트 안내」 구획을 그릴지.
 *
 * 글도 이미지도 없으면 **제목만 남은 빈 상자**가 된다 — 그것도 미완성으로 읽힌다.
 */
export function showsIntroSection(intro: string | null, imageCount: number): boolean {
  return Boolean(intro) || imageCount > 0;
}
