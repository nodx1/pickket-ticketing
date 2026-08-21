/**
 * 좌석 판매 방식 판정 — v2 `events.seat_type` 을 화면 분기값으로 좁힌다.
 *
 * 판정을 한 곳에 모으는 이유: 값이 없던 기존 이벤트(구버전 v2 응답 포함)를
 * **assigned 로 보는 것**이 회귀 방지의 핵심인데, 그 폴백이 화면마다 흩어지면
 * 한 곳만 `unassigned` 로 기울어도 기존 지정석 행사의 배치도가 사라진다.
 */

export type SeatType = "assigned" | "unassigned";

/**
 * 알 수 없는 값·미전송은 전부 `assigned`(현행 동작).
 * 자유입장은 **명시적으로 `"unassigned"` 일 때만** 성립한다.
 */
export function resolveSeatType(raw: unknown): SeatType {
  return raw === "unassigned" ? "unassigned" : "assigned";
}

/** 배치도 에디터를 띄울지 — 지정석 행사에서만 띄운다. */
export function showsSeatMapEditor(seatType: SeatType): boolean {
  return seatType === "assigned";
}
