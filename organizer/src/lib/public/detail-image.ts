/**
 * 상세 이미지 — 이벤트 소개에 세로로 이어 붙이는 안내 이미지.
 *
 * ## 왜 마크다운·리치에디터가 아니라 이미지인가
 * 한국 예매 사이트(인터파크·예스24·멜론티켓)의 소개란은 대부분 **세로로 긴 상세 이미지**다.
 * 주최자는 이미 디자인된 이미지를 갖고 있고, 에디터 사용법을 배울 필요가 없다.
 * 리치 텍스트는 XSS 방어(sanitize)·스타일 충돌·모바일 깨짐을 전부 떠안아야 하는데,
 * 이미지는 **폭 100%·높이 자동**이라 구조적으로 깨질 수가 없다.
 *
 * 접근성·SEO·번역이 안 되는 것이 대가다. 그래서 텍스트 소개를 **대체하지 않고 덧붙인다**.
 * 캡션(=alt)을 받는 이유도 그것이다 — 낭독기와 검색엔진에는 그 문장만 남는다.
 *
 * ## 저장 위치
 * `homepage_design` JSONB 안에 둔다(v2 스키마 변경 0건). 갤러리(`gallery_images`)와
 * 달리 전용 컬럼이 없어서인데, 그 대가로 **PUT 전체 교체**라는 함정이 붙는다 —
 * 홈페이지 디자이너가 저장할 때 이 값을 실어 보내지 않으면 사라진다.
 * 그래서 zod 스키마에 반드시 필드가 있어야 하고(없으면 strip), 설정 화면은
 * 전체 교체가 아닌 **부분 병합(PATCH)** 으로 저장한다.
 */

/** 캡션 최대 길이 — 갤러리와 같은 값을 쓴다(주최자가 두 규칙을 외우게 하지 않는다). */
export const DETAIL_CAPTION_MAX = 120;

/**
 * 이미지를 붙일 자리 — 주최자가 업로드할 때 고른다 (2026-07-30).
 *
 * 🔴 왜 섹션을 나누는가 (대표 지시)
 * "장소·주차 안내, 문의·공유에도 이미지를 넣게 해줘야 **사용자들이 디자인을 통일해서** 넣는다."
 * KLPGA 급 대회는 안내물 디자인 가이드가 이미 있는데, 우리 텍스트 스타일로 강제하면
 * 그걸 못 쓴다. 주최자가 만든 이미지를 각 자리에 그대로 놓을 수 있어야 한다.
 */
export const DETAIL_SECTIONS = ["intro", "transport", "parking", "contact"] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/** 화면에 보여줄 섹션 이름 — 업로드 UI 의 선택 항목이기도 하다. */
export const DETAIL_SECTION_LABELS: Record<DetailSection, string> = {
  intro: "이벤트 안내",
  transport: "대중교통 안내",
  parking: "주차 안내",
  // 2026-07-31 공유 버튼을 상세에서 뺐다 — 더 이상 "공유" 섹션이 아니다.
  contact: "문의",
};

/**
 * 섹션별 상한 — 총 8장.
 *
 * `intro` 가 3장인 것은 대표 판단이다("맥스 3개정도가 좋아 사람들이 스크롤해서 내리기에").
 * 세로로 이어 붙는 구조라 그 이상은 스크롤이 길어진다. 나머지는 안내문 성격이라 1~2장.
 */
export const DETAIL_SECTION_MAX: Record<DetailSection, number> = {
  intro: 3,
  transport: 2,
  parking: 2,
  contact: 1,
};

/** 전체 상한 — 섹션 상한의 합. zod 가 배열 길이를 이 값으로 막는다. */
export const DETAIL_IMAGE_MAX = Object.values(DETAIL_SECTION_MAX).reduce((a, b) => a + b, 0);

/**
 * 섹션 값 정규화.
 *
 * 🔴 **모르는 값·없는 값은 `intro`** 다. 섹션 개념이 생기기 전에 저장된 이미지는
 *    section 필드가 없다 — 그것들이 소개란에 그대로 남아야 마이그레이션이 필요 없다.
 */
export function resolveDetailSection(raw: unknown): DetailSection {
  return DETAIL_SECTIONS.includes(raw as DetailSection) ? (raw as DetailSection) : "intro";
}

export interface DetailImageView {
  /** 마스터 URL. 상세 이미지는 원본 그대로 띄운다(축소 렌디션은 글자가 뭉갠다). */
  url: string;
  /** 낭독기·검색엔진에 전달될 대체 텍스트 */
  alt: string;
  /** 어느 자리에 붙는지 */
  section: DetailSection;
}

/** 캡션 정규화 — 문자열이 아니거나 공백뿐이면 null, 최대 길이에서 자른다. */
export function normalizeDetailCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, DETAIL_CAPTION_MAX);
}

/**
 * 원시 `homepage_design.detailImages` → 렌더용 목록.
 *
 * 🔴 url 이 없는 요소는 버린다. 세로로 이어 붙이는 화면이라 빈 칸이 생기면
 *    본문 한가운데가 뚫린 것처럼 보인다.
 */
export function toDetailImageViews(raw: unknown, eventTitle: string): DetailImageView[] {
  if (!Array.isArray(raw)) return [];

  const views: DetailImageView[] = [];
  // 섹션별로 세어 상한을 개별 적용한다 — 전체 상한만 두면 한 섹션이 8장을 다 먹는다.
  const perSection = new Map<DetailSection, number>();

  for (const entry of raw) {
    const item = typeof entry === "string" ? { url: entry } : entry;
    if (typeof item !== "object" || item === null) continue;

    const record = item as { url?: unknown; caption?: unknown; section?: unknown };
    if (typeof record.url !== "string" || record.url === "") continue;

    const section = resolveDetailSection(record.section);
    const used = perSection.get(section) ?? 0;
    if (used >= DETAIL_SECTION_MAX[section]) continue;
    perSection.set(section, used + 1);

    const caption = normalizeDetailCaption(record.caption);
    views.push({
      url: record.url,
      // 🔴 번호는 **섹션 안에서** 센다 — 전체 순번을 쓰면 "주차 안내 5" 처럼
      //    그 섹션에 5장이 없는데도 5번이라 읽혀 낭독기 안내가 어긋난다.
      alt: caption ?? `${eventTitle} ${DETAIL_SECTION_LABELS[section]} ${used + 1}`,
      section,
    });
  }
  return views;
}

/**
 * 특정 섹션의 이미지만 골라낸다 — 렌더 지점(소개 본문 아래·교통 박스·주차 박스·문의)에서 쓴다.
 */
export function detailImagesFor(
  views: DetailImageView[],
  section: DetailSection,
): DetailImageView[] {
  return views.filter((v) => v.section === section);
}
