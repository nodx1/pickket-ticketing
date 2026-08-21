/**
 * 티켓번호 파생 — v2 ticket id → 사람이 읽는 티켓번호(소비자 URL 키).
 *
 * T2-ORD: 이 공식은 **go 앵커 write 와 v2 발권이 반드시 일치**해야 하는 계약이다.
 * (v2 정본: `platform/backend/app/models/ticket.py::derive_ticket_number`)
 * 결정적이라 재시도/복구에도 값이 흔들리지 않고, 이미 배포된 `/tickets/{n}` 링크·QR·
 * Apple/Google 지갑 패스가 go 제거 후에도 그대로 유효하다.
 *
 * 인라인 문자열 조작이 여러 곳에 흩어져 있으면 한 곳만 바뀌어도 **접근 불가 티켓**이 생기므로
 * 단일 함수로 고정한다.
 */
export function deriveTicketNumber(ticketId: string): string {
  return `TKT-${ticketId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}
