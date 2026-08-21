/**
 * 정가(할인 전) 취소선 표시 판정.
 *
 * ## 🔴 왜 함수로 빼는가
 * 상세 페이지와 체크아웃 1단계 **두 화면**이 같은 규칙을 써야 한다. 각자 조건을 적으면
 * 한쪽만 고쳐지고 두 화면이 갈린다(오늘 초대권 화면에서 날짜 형식이 세 갈래로 갈렸다).
 *
 * ## 규칙 — KLPGA 하나 보고 만들지 않는다
 * ```
 * facePrice > price     → 취소선을 그린다
 * facePrice == price    → 안 그린다      (할인이 아니다)
 * facePrice == null     → 안 그린다      (정가 미시딩)
 * facePrice <= 0        → 안 그린다      (~~₩0~~ 방지)
 * price 가 이상한 값     → 안 그린다      (숫자가 아니면 판정 불가)
 * ```
 *
 * ⚠️ 정가가 없거나 같은 다른 행사에서 `~~₩0~~` 이나 `~~₩13,500~~ ₩13,500` 이 뜨면
 *    할인 미표시보다 **더 큰 사고**다. 그래서 기본값은 "안 그린다" 다.
 */

/** 취소선으로 보여줄 정가. 보여주지 않을 때는 `null`. */
export function strikethroughPrice(
  price: number | string | null | undefined,
  facePrice: number | string | null | undefined,
): number | null {
  const sale = toAmount(price);
  const face = toAmount(facePrice);
  if (sale === null || face === null) return null;
  // 0 이하 정가는 데이터 이상이다 — 그리지 않는다.
  if (face <= 0) return null;
  // 같거나 더 싼 "정가" 는 할인이 아니다.
  if (face <= sale) return null;
  return face;
}

/** 숫자로 읽을 수 있을 때만 숫자. 문자열 금액(`"13500"`)도 허용한다. */
function toAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
