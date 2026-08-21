/**
 * 공통 UI 스타일 상수
 *
 * 사용법:
 *   import { CARD, BTN, BADGE } from "@/lib/styles";
 *   <div className={CARD.base}>...</div>
 *   <div className={cn(CARD.base, "mt-4")}>...</div>
 */

/* ── 카드 / 컨테이너 ────────────────────────────────────────── */
export const CARD = {
  /** 기본 섹션 카드 */
  base: "rounded-2xl bg-background border border-border dark:border-white/10 shadow-sm p-5 lg:p-6",
  /** 패딩 없는 카드 (내부에서 직접 패딩 처리) */
  shell:
    "rounded-2xl bg-background border border-border dark:border-white/10 shadow-sm overflow-hidden",
  /** 리스트 아이템 */
  item: "rounded-2xl bg-card p-4 shadow-none hover:shadow-md hover:-translate-y-0.5 transition-all duration-200",
  /** 소형 정보 카드 (stat, tip) */
  compact: "rounded-2xl bg-card p-4",
} as const;

/* ── 버튼 ────────────────────────────────────────────────────── */
export const BTN = {
  /** Primary CTA (큰 버튼) */
  primary:
    "rounded-full bg-primary text-white hover:bg-primary/90 text-sm font-semibold px-5 py-2.5 transition-colors",
  /** Secondary / Outline */
  secondary:
    "rounded-full border border-border text-foreground hover:bg-muted text-sm font-medium px-5 py-2.5 transition-colors",
  /** 소형 액션 (이관장, 양도하기, 취소 등) */
  action: "rounded-full text-xs font-medium h-8 px-3 transition-colors",
  /** 풀폭 CTA */
  ctaFull:
    "w-full rounded-full bg-primary text-white hover:brightness-110 active:scale-[0.98] text-base font-bold py-4 shadow-sm transition-all",
  /** 비활성 */
  disabled: "opacity-50 cursor-not-allowed",
} as const;

/* ── 배지 / 칩 ───────────────────────────────────────────────── */
export const BADGE = {
  /** 기본 배지 */
  base: "text-xs rounded-full px-2.5 py-0.5 font-medium",
  /** 필터 칩 (활성) */
  chipActive:
    "rounded-full text-xs font-medium px-3 py-1.5 bg-primary text-white shadow-sm",
  /** 필터 칩 (비활성) */
  chipInactive:
    "rounded-full text-xs font-medium px-3 py-1.5 bg-muted text-muted-foreground hover:text-foreground transition-colors",
} as const;

/* ── 시맨틱 배지 색상 ────────────────────────────────────────── */
export const BADGE_COLOR = {
  success: "bg-emerald-100 text-emerald-700",
  info: "bg-blue-100 text-blue-700",
  warning: "bg-orange-100 text-orange-700",
  error: "bg-red-100 text-red-700",
  muted: "bg-muted text-muted-foreground",
} as const;
