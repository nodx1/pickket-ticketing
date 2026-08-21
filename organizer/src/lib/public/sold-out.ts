/**
 * 공개 상세의 **매진 판정**.
 *
 * 🔴 2026-07-28 적대 감사 F-3: 이 판정식은 원래 `page.tsx`(서버 컴포넌트) 안에 인라인으로
 *    있었다. 서버 컴포넌트라 **어떤 테스트도 import 하지 않았고**, 감사가 `every` → `some`
 *    으로 뒤집는 뮤테이션을 넣었는데 1220개 테스트가 **전부 통과**했다.
 *    (= "일부 등급만 소진돼도 전체 매진" — 오늘 오전에 고친 사고의 정반대 방향)
 *    ⟹ 판정 로직을 순수 함수로 분리해 회귀가 닿게 한다.
 *
 * ## 판정 규칙
 *  - `stock`  = **잔여**(= capacity − sold_count). `null` = 무제한(sentinel).
 *  - 매진 = **판매중인 등급이 하나 이상 있고, 그 전부가 잔여 0**.
 *
 * 왜 "전부"인가: 일부 등급만 소진된 상태를 매진으로 표시하면 **팔 수 있는 표를 못 판다**.
 * 왜 "판매중"만 보는가: 판매 전/종료 등급(`isOnSale=false`)은 재고와 무관하게 살 수 없으므로
 *   매진 판정에 넣으면 "아직 안 연 등급 때문에 매진" 같은 오판이 난다.
 * 무제한이 하나라도 있으면 매진이 아니다(그 등급은 계속 팔린다).
 */
export interface SoldOutProduct {
  stock: number | null;
  isOnSale?: boolean;
}

export function isEventSoldOut(products: readonly SoldOutProduct[]): boolean {
  const purchasable = products.filter((p) => p.isOnSale !== false);
  if (purchasable.length === 0) return false;
  return purchasable.every((p) => p.stock !== null && p.stock <= 0);
}
