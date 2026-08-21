/**
 * 공개 랜딩 갤러리 아이템 정규화 — 캡션·alt·렌디션 선택.
 *
 * 🔴 왜 순수 함수로 빼는가
 * 갤러리는 서버 컴포넌트(`e/[eventSlug]/page.tsx`) 안에서 렌더된다. 그 안에 로직을 두면
 * **테스트가 원리적으로 닿지 못한다** — 이 프로젝트에서 반복된 실패 유형이다.
 * ("테스트가 없다"가 아니라 "테스트가 닿을 수 없다"는 커버리지 숫자로 안 보인다.)
 *
 * 🔴 왜 요소 형태를 방어하는가
 * `gallery_images` 는 v2 에서 **JSONB 로 그대로 저장**된다(요소 구조 미검증).
 * 그래서 이 자리에는 이론상 무엇이든 들어올 수 있고, 실제로 초대권 화면은 같은 데이터를
 * `string | {url}` 두 형태로 받는 것을 전제하고 있다. 여기서도 같은 폭을 받아낸다.
 */

/** 캡션 최대 길이 — zod(`api/events/route.ts`·`api/events/[eventId]/route.ts`)와 같은 값 */
export const GALLERY_CAPTION_MAX = 120;

/**
 * 갤러리 최대 장수 — **여기가 정본**이다.
 *
 * 🔴 종전에는 이 숫자가 세 곳에 흩어져 있었다:
 *    `gallery-schema.ts`(zod) · `gallery-upload.tsx`(컴포넌트 기본값) ·
 *    `event-form.tsx`(라벨 문자열 "최대 4장").
 * 하나만 고치면 나머지가 거짓말을 한다. 어제 상세 이미지 테스트에 `/최대 10장/` 을
 * 문자열로 박아뒀다가 상한이 바뀌자 그것만 깨진 것과 같은 유형이다.
 *
 * ⚠️ zod 파일이 아니라 이 파일에 두는 이유: 클라이언트 컴포넌트가 import 해도
 *    zod 가 번들에 딸려오지 않는다(트리셰이킹에 의존하지 않는다).
 */
export const GALLERY_MAX_IMAGES = 4;

export interface GalleryView {
  /** 마스터 URL — 라이트박스에서 원본으로 띄운다 */
  url: string;
  /** 그리드 썸네일 — 렌디션이 있으면 그쪽을 쓴다 */
  thumbUrl: string;
  /** 주최자가 넣은 설명. 없으면 null */
  caption: string | null;
  /** 낭독기·검색엔진에 전달될 대체 텍스트 */
  alt: string;
}

/** 캡션 정규화 — 문자열이 아니거나 공백뿐이면 null, 최대 길이에서 자른다. */
export function normalizeGalleryCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, GALLERY_CAPTION_MAX);
}

/**
 * alt 결정 — 캡션이 있으면 캡션이 곧 대체 텍스트다.
 * 없을 때만 `"{행사명} 갤러리 N"` 으로 떨어진다(종전 동작).
 */
export function resolveGalleryAlt(caption: string | null, eventTitle: string, index: number): string {
  if (caption !== null) return caption;
  return `${eventTitle} 갤러리 ${index + 1}`;
}

/**
 * 원시 `gallery_images` → 렌더용 목록.
 * url 이 없는 요소는 **버린다**(빈 이미지 칸이 생기는 것보다 낫다).
 */
export function toGalleryViews(raw: unknown, eventTitle: string): GalleryView[] {
  if (!Array.isArray(raw)) return [];

  const views: GalleryView[] = [];
  for (const entry of raw) {
    const item = typeof entry === "string" ? { url: entry } : entry;
    if (typeof item !== "object" || item === null) continue;

    const record = item as { url?: unknown; variants?: unknown; caption?: unknown };
    if (typeof record.url !== "string" || record.url === "") continue;

    const variants = (typeof record.variants === "object" && record.variants !== null
      ? (record.variants as Record<string, unknown>)
      : null);
    const thumb = variants && typeof variants.thumb === "string" && variants.thumb !== "" ? variants.thumb : null;

    const caption = normalizeGalleryCaption(record.caption);
    views.push({
      url: record.url,
      thumbUrl: thumb ?? record.url,
      caption,
      alt: resolveGalleryAlt(caption, eventTitle, views.length),
    });
  }
  return views;
}
