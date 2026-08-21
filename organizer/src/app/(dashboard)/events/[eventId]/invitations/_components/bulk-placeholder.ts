/**
 * 명단 붙여넣기 **예시 문구** — 이 행사의 실제 입장일을 쓴다.
 *
 * 🔴 종전엔 `2026-10-03` 이 하드코딩돼 있었다. 행사가 8월인데 예시는 10월이라,
 *    주최자가 예시를 그대로 채워 넣으면 "대회 기간 내 날짜가 아닙니다" 로 **전건 거부**된다.
 *    바로 위 「입장일」 칸은 실제 행사일을 보여주는데 예시만 딴 날짜인 상태였다.
 *
 * 예시는 **그대로 복사해도 통과해야** 한다. 통과 못 하는 예시는 안내가 아니라 함정이다.
 */
export function buildBulkPlaceholder(isDaypass: boolean, dayValues: string[]): string {
  if (!isDaypass) return "홍길동, 01012345678\n김철수, 01098765432";
  const d1 = dayValues[0] ?? "YYYY-MM-DD";
  const d2 = dayValues[1] ?? d1;
  return `홍길동, 01012345678, ${d1}\n김철수, 01098765432, ${d2}`;
}
