/**
 * 티켓/초대권 로고 URL 해석 — 키 불일치를 한 곳에서 흡수한다.
 *
 * ── 무엇이 깨져 있었나 ──
 * 티켓 디자이너는 `logoImageUrl` 로 **저장**하는데, 공개 초대권 화면은 `logoUrl` 을 **읽었다**
 * (`tickets/[ticketNumber]/page.tsx`). 주최자가 로고를 넣어도 실제 티켓에는 영영 안 나온다.
 * 화면끼리 키가 어긋난 것이라 저장도 되고 미리보기도 되니, 실물을 보기 전엔 모른다.
 *
 * ── 정본은 `logoUrl` ──
 * 초대권 편집(F5)이 쓰는 키이고 공개 화면이 읽는 키다. 디자이너를 이쪽으로 옮기되,
 * **이미 `logoImageUrl` 로 저장된 데이터가 사라지면 안 되므로** 읽을 때 폴백한다.
 *
 * ⚠️ 폴백 경로는 둘이고 서로 다르다 — 하나로 뭉치면 안 된다.
 *   ① **키가 없다** → 여기서 처리한다(다른 키를 본다). 순수 판정이라 단위 검사 대상.
 *   ② **키는 있는데 파일이 404** → 여기서는 알 수 없다(URL 문자열만 보고는 판별 불가).
 *      렌더 시점에 `onError` 로 감춘다. 안 하면 깨진 이미지 아이콘이 티켓에 박힌다.
 */
export interface TicketLogoSource {
  /** 정본 키 — 초대권 편집·공개 화면이 쓰는 쪽. */
  logoUrl?: string | null;
  /** 레거시 키 — 옛 티켓 디자이너가 저장하던 쪽. 읽기 전용 폴백. */
  logoImageUrl?: string | null;
}

/**
 * 표시할 로고 URL. 없으면 `null`.
 *
 * 공백만 있는 값은 "없음"으로 본다 — `""` 나 `"  "` 를 그대로 넘기면 `<img src="">` 가 되어
 * 현재 페이지를 다시 요청하는 브라우저 동작이 붙는다.
 */
export function resolveTicketLogoUrl(design: TicketLogoSource | null | undefined): string | null {
  const primary = design?.logoUrl?.trim();
  if (primary) return primary;
  const legacy = design?.logoImageUrl?.trim();
  if (legacy) return legacy;
  return null;
}
