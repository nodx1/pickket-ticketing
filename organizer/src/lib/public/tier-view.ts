/**
 * 공개 경로가 v2 티어 카탈로그를 읽는 **단일 규칙**.
 *
 * 🔴 2026-07-28 적대 감사 F-5: 공개 상세(`lib/server/events.ts`)는 v2 카탈로그로 넘어갔는데
 *    임베드 위젯(`api/public/events/[slug]/widget-config`)만 go `products` 를 직접 SELECT 하고
 *    있었다. W2-PS 이후 상품 생성은 v2 단독 write 라 go `products` 에는 **새 행이 생기지 않는다**
 *    (prod 실측: KLPGA 이벤트 0행) ⟹ 위젯은 상품 0개로 렌더됐다.
 *    같은 결함이 두 번 재발한 이유는 "필터·잔여 계산"이 라우트마다 복붙돼 있었기 때문이다.
 *    ⟹ 규칙을 여기 한 곳에 두고 두 경로가 공유한다.
 *
 * ## 재고 계약 — 세 값의 이름과 뜻
 *  - `capacity`(v2)   = 집행 **총좌석**. 무제한이면 `1,000,000` sentinel(`UNLIMITED_TIER_CAPACITY`).
 *                       `stock_limit`(주최자 입력 원본)은 이미 반영돼 있다(v2 `_effective_capacity`).
 *  - `sold_count`(v2) = 환불 제외 판매수(SoT).
 *  - **잔여** = `capacity − sold_count`. 판매를 실제로 막는 기준(v2 `internal_commerce.py:3980`
 *               409 SOLD_OUT)과 **같은 식**이라, 표시가 집행과 어긋나지 않는다.
 *
 * 무제한은 두 값 모두 `null` 로 내보낸다 — sentinel 을 그대로 흘리면 "재고 100만장"이 된다.
 *
 * ⚠️ `stock_limit` 을 잔여로 쓰지 마라. 좌석등급 경로는 이 값을 보내지 않아(NULL) 화면이
 *    폴백값으로 새고, 완판돼도 매진이 뜨지 않는다(감사 F-3 의 원인).
 *
 * ## 실패 취급
 * 이 모듈은 순수 함수만 둔다. 조회(`listTierCatalog`)는 호출부가 하고, **실패를 빈 목록으로
 * 흘리지 않는다**(`lib/v2/tier-catalog.ts` 상단 원칙). 빈 상품 목록은 화면에서 "매진"과
 * 구별되지 않기 때문이다.
 */
import type { TierCatalogRow } from "@/lib/v2/commerce-client";
import { UNLIMITED_TIER_CAPACITY } from "@/lib/v2/tier-catalog";

/** 판정에 필요한 최소 형태(테스트가 전체 행을 만들 필요 없게). */
export type PublicTierInput = Pick<TierCatalogRow, "capacity" | "sold_count"> &
  Partial<Pick<TierCatalogRow, "is_active" | "visibility" | "sale_window">>;

/**
 * 공개 노출 대상인가. 비활성·비공개(private/hidden) 티어는 공개 경로에서 제외한다.
 * `is_active`/`visibility` 가 없는(레거시) 행은 노출로 본다 — 숨김은 명시적일 때만.
 */
export function isPubliclyVisibleTier(tier: PublicTierInput): boolean {
  return (
    tier.is_active !== false && tier.visibility !== "private" && tier.visibility !== "hidden"
  );
}

/**
 * 집행 **총좌석**. 무제한 sentinel 은 `null`.
 * (잔여가 아니다 — 이름 그대로 총량이다. 감사 F-6.)
 */
export function tierTotalCapacity(tier: Pick<TierCatalogRow, "capacity">): number | null {
  const capacity = Number(tier.capacity ?? 0);
  if (!Number.isFinite(capacity)) return null;
  return capacity >= UNLIMITED_TIER_CAPACITY ? null : Math.max(0, capacity);
}

/**
 * **잔여** = 총좌석 − 판매수. 무제한은 `null`.
 * 음수는 0 으로 클램프한다(초과판매 상태에서 "-3장"을 표시하지 않기 위해).
 */
export function tierRemainingStock(tier: PublicTierInput): number | null {
  const capacity = tierTotalCapacity(tier);
  if (capacity === null) return null;
  const sold = Number(tier.sold_count ?? 0);
  return Math.max(0, capacity - (Number.isFinite(sold) ? sold : 0));
}

/**
 * 판매창 기준 판매중 여부. 창이 없으면(둘 다 null) 이벤트 판매창을 따르므로 판매중으로 본다.
 */
export function tierIsOnSale(
  tier: Pick<Partial<TierCatalogRow>, "sale_window">,
  nowMs: number = Date.now(),
): boolean {
  const opens = tier.sale_window?.opens_at ? Date.parse(tier.sale_window.opens_at) : null;
  const closes = tier.sale_window?.closes_at ? Date.parse(tier.sale_window.closes_at) : null;
  return (
    (opens === null || Number.isNaN(opens) || opens <= nowMs) &&
    (closes === null || Number.isNaN(closes) || closes >= nowMs)
  );
}

/**
 * 공개 경로가 노출할 티어만 남긴다.
 *
 * 정렬은 주최자가 정한 `sort_order` 만 본다(옛 go `ORDER BY sort_order ASC, created_at ASC`).
 * 동순위는 **입력 순서를 보존**한다(Array#sort 는 안정 정렬) — v2 는 `created_at` 을 응답에
 * 싣지 않으므로 이름 같은 임의 기준으로 2차 정렬하면 주최자가 보던 순서가 뒤집힌다.
 */
export function selectPublicTiers(tiers: readonly TierCatalogRow[]): TierCatalogRow[] {
  return tiers
    .filter((t) => isPubliclyVisibleTier(t))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}
