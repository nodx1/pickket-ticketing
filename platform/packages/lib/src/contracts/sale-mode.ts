/**
 * Sale Mode 공유 계약 (v3.0 정본)
 *
 * 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * 적용: pickket.v2, pickket.go (로컬 복사), pickket.v2.app
 */

export const SALE_MODES = [
  "fanclub_presale",
  "point_lottery",
  "queue",
  "fixed_fcfs",
] as const;

export type SaleMode = (typeof SALE_MODES)[number];

/** 레거시 값 → canonical 변환 맵 */
const LEGACY_MAP: Record<string, SaleMode> = {
  lottery: "point_lottery",
  fanclub: "fanclub_presale",
  fcfs: "fixed_fcfs",
};

/**
 * 어떤 sale_mode 값이든 → canonical 값으로 변환.
 *
 * NOTE: 기존 format.ts의 normalizeSaleMode()는 반대 방향 (canonical → display key).
 * 이 함수는 legacy/go/any → canonical 방향이므로 이름이 다름.
 */
export function toCanonicalSaleMode(raw: string): SaleMode {
  if (SALE_MODES.includes(raw as SaleMode)) return raw as SaleMode;
  return LEGACY_MAP[raw] ?? "fixed_fcfs";
}

/** canonical 키 기반 라벨 (신규 코드 + go/mobile 동기화용) */
export const CANONICAL_SALE_MODE_LABELS: Record<
  SaleMode,
  { ko: string; en: string }
> = {
  fanclub_presale: { ko: "멤버십 선판매", en: "Members Presale" },
  point_lottery: { ko: "공정 추첨", en: "Fair Lottery" },
  queue: { ko: "대기열 판매", en: "Queue Sale" },
  fixed_fcfs: { ko: "잔여 선착순", en: "First Come First Served" },
};
