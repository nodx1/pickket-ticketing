/**
 * 「언제·어디서」 한 줄 — **순수 모듈**.
 *
 * ## 🔴 왜 필요한가 (2026-08-01 감사 P1-①)
 * 체크아웃 1~3단계 어디에도 **행사 일시·장소가 없었다.** 행사명과 금액뿐이고,
 * `startsAt`·`venueName` 은 **완료 페이지(4단계)에만** 나왔다.
 *
 * 이 대회는 **주중권(목~금) / 주말권(토~일)** 로 날짜가 갈린다. 잘못 고른 것을
 * **결제가 끝난 뒤에** 알게 되는 구조였다 — 그때부터는 환불 절차다.
 *
 * ⚠️ 값이 없으면 **빈 문자열**을 돌려준다. "미정" 같은 말을 지어내지 않는다 —
 *    호출부가 그 줄을 아예 안 그리면 된다.
 */
import { formatDateKst, formatTimeKst, formatWeekdayKst } from "@/lib/format";

/**
 * `2026년 8월 20일(목) 오전 7:00 · 포천힐스CC` 형태의 한 줄.
 *
 * ⚠️ 날짜가 깨진 문자열이면 **날짜를 버리고 장소만** 돌려준다. 여기서 던지면
 *    체크아웃 화면 전체가 죽는다 — 부가 정보 한 줄 때문에 결제를 막지 않는다.
 */
export function formatWhenWhere(
  startsAt: string | null | undefined,
  venueName: string | null | undefined,
): string {
  const parts: string[] = [];

  if (startsAt) {
    const d = new Date(startsAt);
    if (!Number.isNaN(d.getTime())) {
      // ⚠️ 한 번에 weekday 까지 넣으면 `20일 목 오전 7:00` 처럼 붙어 읽기 나쁘다.
      //    조각을 따로 만들어 `2026년 8월 20일(목) 오전 7:00` 로 조립한다.
      // 🔴 포맷터는 `lib/format` 것을 쓴다 — KST 규칙이 여러 곳에 흩어지지 않게 한다.
      parts.push(`${formatDateKst(d, "")}(${formatWeekdayKst(d)}) ${formatTimeKst(d, "")}`);
    }
  }

  const venue = typeof venueName === "string" ? venueName.trim() : "";
  if (venue) parts.push(venue);

  return parts.join(" · ");
}
