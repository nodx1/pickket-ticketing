/**
 * 이벤트 개설 시점의 판매창 최선 추정.
 *
 * ## 왜 필요했나 — 이미 시작한 행사를 등록할 수 없었다
 * 종전에는 `{ opens_at: now, closes_at: startsAt }` 을 그대로 보냈다.
 * 시작 일시가 **과거**면 `closes_at < opens_at` 이 되고 v2 가 400 으로 거절한다:
 *
 *     internal_commerce.py:718
 *       if closes_at <= opens_at:
 *         raise ApiError("VALIDATION_ERROR", "sale_window.closes_at must be after opens_at", 400)
 *
 * 당일 급조 등록·진행 중인 행사 등록·지난 행사 기록용 등록이 전부 막혔고,
 * 화면에는 "잠시 후 다시 시도해주세요" 가 떠서 **재시도로는 영원히 풀리지 않았다.**
 *
 * ## 규칙
 * - 시작이 **미래**면 `지금 ~ 시작 일시`. 판매는 보통 행사 시작과 함께 닫힌다.
 * - 시작이 **지났으면 행사 기간 자체를 판매창으로** 쓴다(`시작 ~ 종료`).
 *   진행 중인 행사는 지금이 창 안이라 그대로 팔리고, **지난 행사는 창이 이미 닫혀 있다.**
 *
 * 🔴 지난 행사에 `지금 ~ 지금+1시간` 을 주면 안 된다(회신 #19 지적). v2 주문 게이트는
 * `status`·`sale_window`·`sales_paused` 만 보고 **event_date 가 지났는지는 보지 않아서**,
 * 기록용으로 등록한 지난 행사에 1시간짜리 판매창이 열린다. 과거 창을 주면 v2 의
 * `closes_at > opens_at` 검증은 통과하면서 처음부터 닫힌 상태가 된다.
 *
 * 개설 시점의 **추정치**일 뿐이고, 이후 sale-plan 화면이 정본으로 재계산한다.
 */

/** 종료도 과거일 때 확보하는 최소 판매창(ms). */
const FALLBACK_WINDOW_MS = 60 * 60 * 1000;

export interface SaleWindow {
  opens_at: string;
  closes_at: string;
}

export function resolveInitialSaleWindow(
  startsAtIso: string,
  endsAtIso: string | null,
  nowIso: string,
): SaleWindow {
  const now = new Date(nowIso).getTime();
  const starts = new Date(startsAtIso).getTime();

  // 시작 일시를 못 읽는다(깨진 입력) — 등록 자체를 막지는 않되 최소창만 준다.
  if (!Number.isFinite(starts)) {
    return { opens_at: nowIso, closes_at: new Date(now + FALLBACK_WINDOW_MS).toISOString() };
  }

  if (starts > now) {
    return { opens_at: nowIso, closes_at: startsAtIso };
  }

  // 시작이 지났다 — 행사 기간을 그대로 판매창으로 쓴다.
  //   진행 중이면 지금이 창 안이라 팔리고, 지난 행사면 창이 이미 닫혀 있다.
  const ends = endsAtIso ? new Date(endsAtIso).getTime() : Number.NaN;
  const closesAt =
    Number.isFinite(ends) && ends > starts
      ? endsAtIso!
      : new Date(starts + FALLBACK_WINDOW_MS).toISOString();
  return { opens_at: startsAtIso, closes_at: closesAt };
}
