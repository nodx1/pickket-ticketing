/**
 * **공개 경로에서 팔아도 되는 티어인가** — 무인증 구매 진입점의 공통 관문.
 *
 * ## 🔴 왜 필요한가 (2026-08-01 오픈 직전 발견)
 * 티어에는 `visibility` 가 있고 `"hidden"`/`"private"` 는 **주최자만 발급**하는 것이다
 * (초대권 = 0원, 정원 100만). 그런데 두 곳이 서로 다른 규칙을 쓰고 있었다:
 *
 *     공개 상세 화면   `isPubliclyVisibleTier()` → 숨김 티어를 뺀다        ✅
 *     공개 구매 처리   `tierMap.has(id)` → **이 행사 티어인가만 본다**     ❌
 *
 * ⟹ 메뉴판에서는 빠지는데 **주문은 받아준다.** 초대권 티어 ID 를 아는 사람이
 *    직접 호출하면 0원 주문이 성립하고, 발권된 티켓은 정상 초대권과 **구분되지 않는다**
 *    (게이트는 등급이 무료인지 유료인지 보지 않는다 — 볼 이유도 없다).
 *
 * 대표 지시: **초대권 발급은 대시보드에서만.**
 *
 * ## ⚠️ 대시보드 경로를 막으면 안 된다
 * 주최자가 초대권을 발급하는 것은 **정상 동작**이다
 * (`lib/server/invitations.ts` → `createOrder`). 이 관문은 **무인증 공개 경로에만** 건다:
 *   - `api/checkout/initiate`            일반 구매
 *   - `api/events/[eventId]/public/rsvp` 공개 RSVP
 *   - `api/public/waitlist/[id]/claim`   대기열 클레임
 *
 * 대시보드 발급·단체예약·명단 임포트는 인증된 주최자 행위이므로 통과시킨다.
 *
 * ## 왜 별도 모듈인가
 * 같은 규칙을 진입점마다 적으면 갈라진다 — 오늘 그 계열 사고가 3건 났다
 * (참석자 필터·환불 티켓 QR·현장발권 명단). 판정을 한 곳에 둔다.
 */
import type { TierReadRow } from "@/lib/v2/commerce-client";

/** 공개 경로에서 팔 수 없는 visibility 값. */
const NON_PUBLIC_VISIBILITY = new Set(["hidden", "private"]);

export interface PurchasableVerdict {
  ok: boolean;
  /** 거절 사유 — 로그용. 사용자에게는 상품 존재 여부를 흘리지 않는다. */
  reason?: "hidden" | "inactive" | "unknown_tier";
}

/**
 * 공개 구매 가능 여부.
 *
 * 🔴 **미지값은 통과시킨다.** `visibility` 가 없는 응답(구버전 v2)에서 전부 거절하면
 *    정상 판매가 통째로 멈춘다. 막아야 할 것은 **명시적으로 숨김인 티어**다.
 *    (반대 방향 fail-closed 는 여기선 틀린 선택 — 오픈 당일 판매 중단이 더 큰 사고다.)
 */
export function isPubliclyPurchasable(tier: Pick<TierReadRow, "visibility" | "is_active">): PurchasableVerdict {
  if (tier.is_active === false) return { ok: false, reason: "inactive" };
  const v = String(tier.visibility ?? "").trim().toLowerCase();
  if (v && NON_PUBLIC_VISIBILITY.has(v)) return { ok: false, reason: "hidden" };
  return { ok: true };
}

/**
 * 요청한 상품 목록이 전부 공개 구매 가능한지 확인한다.
 *
 * @param tierMap  go productId(external_ref) → v2 티어
 * @param productIds 요청된 상품 id 목록
 * @returns 문제가 있으면 첫 위반 항목, 없으면 null
 */
export function findNonPurchasable(
  tierMap: ReadonlyMap<string, Pick<TierReadRow, "visibility" | "is_active">>,
  productIds: readonly string[],
): { productId: string; reason: NonNullable<PurchasableVerdict["reason"]> } | null {
  for (const id of productIds) {
    const tier = tierMap.get(id);
    if (!tier) return { productId: id, reason: "unknown_tier" };
    const verdict = isPubliclyPurchasable(tier);
    if (!verdict.ok) return { productId: id, reason: verdict.reason ?? "hidden" };
  }
  return null;
}
