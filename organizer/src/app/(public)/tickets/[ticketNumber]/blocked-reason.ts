/**
 * 티켓 열람이 막힌 이유 — 순수 판정(서버 의존 0).
 *
 * 🔴 page.tsx 안에 두면 테스트가 닿지 않는다(서버 전용 모듈을 import 하므로).
 *    고객에게 보이는 안내를 결정하는 로직이라 검증 가능한 자리에 둔다.
 *
 * 옛 동작은 이유 없이 `/my-tickets` 로 307 했다. 링크 만료·초대권 회수·토큰 누락·
 * 다른 기기 열람이 전부 같은 화면으로 떨어져 고객은 "티켓이 사라졌다" 로 읽었고,
 * 그 화면의 매직링크 메일마저 발신주소 미설정으로 나가지 않아 거기서 막혔다.
 *
 * 화면이 안내를 다르게 해야 하는 경우만 구분한다 — 고객이 할 수 있는 행동은
 * 셋뿐이다(재발송 요청 / 본인확인 / 주최자 문의).
 */
export type TicketBlockedReason = "link_expired" | "ticket_unavailable" | "verify_required";

/** 링크가 남아 있어도 열람 대상이 아닌 상태. */
const UNAVAILABLE_STATUSES = new Set(["cancelled", "expired", "transferred"]);

export function resolveBlockedReason(input: {
  hasToken: boolean;
  status: string | null | undefined;
}): TicketBlockedReason {
  const status = String(input.status ?? "").toLowerCase();
  // 환불·양도·만료 티켓은 링크 유무와 무관하다. 여기에 "재발송을 요청하세요" 라고
  // 안내하면 고객이 주최자에게 헛걸음한다.
  if (UNAVAILABLE_STATUSES.has(status)) return "ticket_unavailable";
  // 링크를 들고 왔는데 안 열렸다 = 만료됐거나 회수됐다 → 재발송 안내.
  if (input.hasToken) return "link_expired";
  // 링크 없이 티켓 주소로만 들어왔다 → 본인확인이 필요하다.
  return "verify_required";
}
