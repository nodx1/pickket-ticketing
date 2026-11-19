/**
 * 피켓고 공개 이벤트 페이지(/e/[slug])의 추첨 등급 처리.
 *
 * 가중치 추첨(point_lottery)·팬클럽 선예매(fanclub_presale) 등급은 피켓 회원이 피켓 마켓에서
 * 응모하는 등급이다. 피켓고 자체 페이지가 이 등급을 「티켓 구매하기」로 보여 주면 추첨을 건너뛰는
 * 길처럼 보이고(서버는 비회원 구매를 막으므로 결제 직전에 오류가 난다) 흐름이 끊긴다.
 * 그래서 추첨 등급만 있는 행사는 구매 버튼 대신 「피켓에서 추첨 응모하기」로 연결한다.
 */
export const LOTTERY_SALE_MODES = new Set(["point_lottery", "fanclub_presale"]);

export const isLotterySaleMode = (mode: string | null | undefined) => LOTTERY_SALE_MODES.has(String(mode ?? ""));

/** 피켓 마켓 주소. 배포에서는 https://pickket.kr, 로컬 개발은 NEXT_PUBLIC_PICKKET_MARKET_URL 로 바꾼다. */
export const PICKKET_MARKET_URL = (process.env.NEXT_PUBLIC_PICKKET_MARKET_URL || "https://pickket.kr").replace(/\/$/, "");

export function marketEventUrl(eventId: string, base = PICKKET_MARKET_URL, locale = "ko") {
  return `${base}/${locale}/events/${encodeURIComponent(eventId)}`;
}

/**
 * 공개 페이지 CTA 모드.
 *  - purchase: 일반 판매 등급만 있음 → 기존 「티켓 구매하기」
 *  - lottery : 입장권 등급이 모두 추첨 → 「피켓에서 추첨 응모하기」
 *  - mixed   : 둘 다 있음 → 구매 버튼은 일반 등급용으로 두고, 추첨 등급은 응모 안내를 붙인다
 */
export function publicCtaMode(products: ReadonlyArray<{ saleMode?: string | null; type?: string | null }>): "purchase" | "lottery" | "mixed" {
  const tickets = products.filter((p) => (p.type ?? "ticket") === "ticket");
  const lottery = tickets.filter((p) => isLotterySaleMode(p.saleMode)).length;
  if (lottery === 0) return "purchase";
  return lottery === tickets.length ? "lottery" : "mixed";
}

/**
 * 피켓(소비자)에 이벤트가 보이는 상태 — 관리자 승인 이후. 심사 전·심사 중·반려는 피켓에 없다.
 * 피켓고 화면은 v2 상태를 6-상태로 투영해 받으므로(domain-model `projectToGoEventStatus`:
 * 승인~배정 → live, 종료·취소 → archived) 투영값과 v2 원래 값을 모두 받는다.
 */
const MARKET_VISIBLE_STATUSES = new Set([
  "live", "archived",
  "approved", "bidding_open", "bidding_closed", "allocating", "allocated", "completed", "cancelled",
]);

/**
 * 피켓고 이벤트 화면의 「피켓에서 보기」 상태.
 *  - live   : 피켓 마켓 채널이 켜져 있고 승인되어 피켓에 공개됨 → 피켓 이벤트 화면 주소
 *  - pending: 피켓 마켓은 켰지만 아직 승인 전 → 승인 뒤에 열린다고 안내
 *  - off    : 피켓 마켓 채널을 안 씀 → 버튼 없음
 */
export function marketViewState(
  event: { id: string; status: string; saleChannels?: ReadonlyArray<string> | null },
  base = PICKKET_MARKET_URL,
): { kind: "live"; url: string } | { kind: "pending" } | { kind: "off" } {
  if (!event.saleChannels?.includes("marketplace")) return { kind: "off" };
  if (!MARKET_VISIBLE_STATUSES.has(event.status)) return { kind: "pending" };
  return { kind: "live", url: marketEventUrl(event.id, base) };
}
