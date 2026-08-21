/**
 * 브랜드 문구 정본 — **여기 하나만** 고치면 전부 따라온다.
 *
 * 🔴 왜 상수로 빼나
 * 브랜드명이 루트 `layout.tsx` 의 `title.template`, 이벤트 상세의 `title`·notFound 문구·
 * `og:title` 까지 **네 곳에 흩어져** 있었다. 그래서 실제로 어긋났다 —
 * 페이지가 `"제목 — PICKKET.GO"` 라는 **평문 문자열**을 주면 루트 template 이 거기에
 * 브랜드를 **한 번 더** 붙여 `제목 — PICKKET.GO — PICKKET.GO` 가 된다.
 * (`og:title` 은 template 을 타지 않아 멀쩡했다 — 그 비대칭이 원인을 확정해 줬다.)
 */
export const SITE_NAME = "PICKKET.GO";

/** 루트 layout 의 `title.template` 값. 자식 페이지의 평문 `title` 뒤에 붙는다. */
export const TITLE_TEMPLATE = `%s — ${SITE_NAME}` as const;

/** 브랜드가 이미 붙은 완성형 제목(template 을 타지 않는 곳 — og/twitter 용). */
export function withBrand(title: string): string {
  return `${title} — ${SITE_NAME}`;
}

export interface EventSeoInput {
  /** 이벤트 제목. */
  eventTitle: string;
  /** 주최자가 설정한 SEO 제목(선택). */
  seoTitle?: string;
  /** 주최자가 설정한 OG 제목(선택). */
  ogTitle?: string;
}

export interface EventSeoTitles {
  /**
   * `metadata.title` 에 넣을 값. **브랜드를 붙이지 않는다** — 루트 template 이 붙인다.
   *
   * ⚠️ 주최자가 `seoTitle` 에 브랜드를 적어 넣으면 여전히 중복된다. 그건 입력 데이터
   *    문제라 여기서 지우지 않는다(주최자가 의도적으로 넣었을 수 있다). 우리 코드가
   *    자동으로 덧붙이는 것만 없앤다.
   */
  title: string;
  /** `openGraph.title`·`twitter.title` 에 넣을 값. 여기는 template 이 안 붙으므로 직접 붙인다. */
  ogTitle: string;
}

/**
 * 이벤트 상세 페이지의 제목 두 종류를 만든다.
 *
 * 순수 함수로 뺀 이유: `generateMetadata` 는 v2 조회에 얽혀 있어 단위 검사가 어렵고,
 * 로컬에 공개 이벤트 데이터가 없어 런타임 확인도 못 한다. 문자열 조립만 떼어내면 검사된다.
 */
export function buildEventSeoTitles(input: EventSeoInput): EventSeoTitles {
  const title = input.seoTitle?.trim() || input.eventTitle;
  const ogTitle = input.ogTitle?.trim() || withBrand(title);
  return { title, ogTitle };
}
