/**
 * 포맷 유틸리티
 * v2의 @pickket/lib/format.ts와 동일한 로직 + i18n 대응
 */
import i18n from "@/i18n";

/** 한국 원화 포맷: 50000 → "₩50,000" (i18n 언어에 따라 표기 변경) */
export function formatKRW(amount: number): string {
  const locale = i18n.language?.startsWith("ko") ? "ko-KR" : "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency: "KRW", maximumFractionDigits: 0 }).format(amount);
}

/** 가격 범위 표시: "₩50,000 ~ ₩150,000" 또는 단일 가격 */
export function formatPriceRange(min?: number | null, max?: number | null): string {
  if (min == null && max == null) return "";
  if (min === 0 && (max === 0 || max == null)) return i18n.t("event.free");
  if (min != null && max != null && min !== max) {
    return `${formatKRW(min)} ~ ${formatKRW(max)}`;
  }
  return formatKRW(min ?? max ?? 0);
}

function getLocale(): string {
  return i18n.language?.startsWith("ko") ? "ko-KR" : "en-US";
}

/** 날짜 포맷: "2026-04-10T19:00:00" → "4월 10일 (금) 19:00" / "Apr 10 (Fri) 19:00" */
export function formatEventDate(dateStr: string): string {
  const date = new Date(dateStr);
  const locale = getLocale();
  const weekday = date.toLocaleDateString(locale, { weekday: "short" });
  const month = date.toLocaleDateString(locale, { month: "short" });
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} (${weekday}) ${hours}:${minutes}`;
}

/** 짧은 날짜: "4.10 (금)" / "4.10 (Fri)" */
export function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr);
  const locale = getLocale();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekday = date.toLocaleDateString(locale, { weekday: "short" });
  return `${month}.${day} (${weekday})`;
}

/** 카테고리별 폴백 배경색 (이미지 없을 때) */
const CATEGORY_COLORS: Record<string, string> = {
  CONCERT: "#6366f1",
  MUSICAL: "#ec4899",
  SPORTS: "#10b981",
  EXHIBITION: "#f59e0b",
  FESTIVAL: "#ef4444",
  THEATER: "#8b5cf6",
  FANMEETING: "#e879f9",
  CLASSIC: "#64748b",
};

export function getCategoryFallbackColor(category?: string | null): string {
  return CATEGORY_COLORS[normalizeCategoryKey(category)] ?? "#4A5BC4";
}

/** 카테고리별 이모지 */
const CATEGORY_EMOJIS: Record<string, string> = {
  CONCERT: "🎵",
  MUSICAL: "🎭",
  SPORTS: "⚽",
  EXHIBITION: "🎨",
  FESTIVAL: "🎪",
  THEATER: "🎬",
  FANMEETING: "💜",
  CLASSIC: "🎻",
};

export function getCategoryEmoji(category?: string | null): string {
  return CATEGORY_EMOJIS[normalizeCategoryKey(category)] ?? "🎫";
}

/**
 * AUDIT §7 P0: 외부 서비스(Unsplash/picsum) 완전 제거
 * 카테고리 브랜드 컬러 + 이모지 기반 SVG data URI 생성.
 * 네트워크 불필요, 저작권/귀속 의무 없음.
 */
const DEFAULT_BRAND_COLOR = "#4A5BC4";

/** hex 컬러 + 이모지 → 인라인 SVG data URI */
function colorPlaceholderUri(hex: string, emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="${hex}"/><text x="300" y="220" font-size="80" text-anchor="middle" dominant-baseline="central">${emoji}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// 카테고리 코드 (대소문자·동의어 지원) → 정규화 키
const CATEGORY_ALIAS: Record<string, string> = {
  CONCERT: "CONCERT", CONCERTS: "CONCERT",
  MUSICAL: "MUSICAL", MUSICALS: "MUSICAL",
  SPORTS: "SPORTS", SPORT: "SPORTS",
  EXHIBITION: "EXHIBITION", EXHIBITIONS: "EXHIBITION",
  FESTIVAL: "FESTIVAL", FESTIVALS: "FESTIVAL",
  THEATER: "THEATER", THEATRE: "THEATER",
  FANMEETING: "FANMEETING", FAN_MEETING: "FANMEETING",
  CLASSIC: "CLASSIC", CLASSICAL: "CLASSIC",
  ESPORTS: "ESPORTS", E_SPORTS: "ESPORTS",
};

/** 카테고리 입력(대소문자/동의어) → 정규화 키. v2는 소문자 category를 보냄. */
function normalizeCategoryKey(category?: string | null): string {
  return CATEGORY_ALIAS[(category ?? "").toUpperCase().trim()] ?? "";
}

// SVG placeholder 캐시 (동일 카테고리 반복 생성 방지)
const _placeholderCache = new Map<string, string>();

/** 카테고리 폴백 이미지 URI 반환 (로컬 SVG data URI, 외부 의존 없음) */
export function getCategoryFallbackImage(category?: string | null, _seed?: string): string {
  const key = normalizeCategoryKey(category);
  if (_placeholderCache.has(key)) return _placeholderCache.get(key)!;
  const color = CATEGORY_COLORS[key] ?? DEFAULT_BRAND_COLOR;
  const emoji = CATEGORY_EMOJIS[key] ?? "🎫";
  const uri = colorPlaceholderUri(color, emoji);
  _placeholderCache.set(key, uri);
  return uri;
}

/** 공백·빈 문자열을 null 취급 */
function nonEmpty(s?: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 이벤트의 실제 이미지 URL 또는 카테고리 폴백 반환 (빈 문자열·공백도 폴백 처리) */
export function resolveEventImage(event: {
  id?: string;
  image_url?: string | null;
  thumbnail_url?: string | null;
  hero_video_url?: string | null;
  category?: string | null;
}): string {
  return (
    nonEmpty(event.image_url) ??
    nonEmpty(event.thumbnail_url) ??
    nonEmpty(event.hero_video_url) ??
    getCategoryFallbackImage(event.category, event.id)
  );
}
