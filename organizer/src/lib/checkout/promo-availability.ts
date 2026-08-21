/**
 * 구매자에게 **프로모코드 입력칸을 보여줄지** 판정한다.
 *
 * ── 왜 필요한가 ──
 * 종전엔 카드사 자동할인이 걸린 행사만 입력칸을 숨기고, **그 외 전부 보여줬다.**
 * 프로모코드를 하나도 만들지 않은 주최자의 구매자도 입력칸을 보고, 뭘 넣든
 * "유효하지 않은 프로모코드입니다" 가 돌아온다 — "내가 코드를 못 받은 건가" 로 읽히는
 * 막다른 길이다. (prod KLPGA 체크아웃에서 실제로 그 상태였다.)
 *
 * ── 🔴 실패 방향은 "보여준다" 다 ──
 * 판정에 쓰는 v2 조회가 실패했을 때 **숨기면**, 유효한 코드를 손에 든 구매자가
 * 쓸 방법이 없어진다(금전 경로 차단). 반대로 보여주면 최악이 종전과 같다.
 * 그래서 모를 때는 **보여준다**(fail-open). 호출부는 조회 실패 시 `null` 을 넘긴다.
 *
 * ── 판정 기준 ──
 * "지금 이 순간 누군가 실제로 쓸 수 있는 코드가 하나라도 있는가".
 * 비활성·기간 밖·한도 소진은 전부 못 쓴다 — 그런 코드만 있으면 입력칸은 여전히 막다른 길이다.
 *
 * ⚠️ 여기서 "쓸 수 있다"는 **대략적 판정**이다. 최소주문금액(`min_order_amount`)은 보지 않는다 —
 *    장바구니 금액에 따라 달라져서, 그것까지 반영하면 담는 도중 입력칸이 나타났다 사라진다.
 *    실제 적용 가부는 서버(`apply-promo` → v2)가 최종 판정한다.
 */

export interface PromoAvailabilityRow {
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  used_count: number;
}

/** 이 코드 하나가 지금 사용 가능한가. */
export function isPromoUsable(row: PromoAvailabilityRow, now: Date): boolean {
  if (!row.is_active) return false;

  if (row.starts_at) {
    const starts = new Date(row.starts_at);
    // 날짜가 깨져 있으면(NaN) 기간 조건은 판정 불가 → 막지 않는다(fail-open).
    if (!Number.isNaN(starts.getTime()) && now < starts) return false;
  }
  if (row.ends_at) {
    const ends = new Date(row.ends_at);
    if (!Number.isNaN(ends.getTime()) && now > ends) return false;
  }

  // usage_limit 이 null 이면 무제한.
  if (row.usage_limit !== null && row.used_count >= row.usage_limit) return false;

  return true;
}

/**
 * 입력칸을 보여줄지.
 *
 * @param rows v2 프로모코드 목록. **조회 실패면 `null`** 을 넘긴다 → 보여준다(fail-open).
 */
export function shouldShowPromoInput(
  rows: PromoAvailabilityRow[] | null | undefined,
  now: Date,
): boolean {
  if (rows === null || rows === undefined) return true; // 모를 때는 막지 않는다
  return rows.some((row) => isPromoUsable(row, now));
}
