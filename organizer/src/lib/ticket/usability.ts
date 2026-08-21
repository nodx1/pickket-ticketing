/**
 * 티켓이 **지금 쓸 수 있는가** — QR 노출·환불버튼·목록 배지가 **같은 출처**를 본다.
 *
 * ## 🔴 왜 필요한가 (2026-08-01 실사고)
 * 김상윤님이 환불을 마쳤는데 **티켓 화면의 QR 이 그대로 살아 있었다.**
 * 게이트는 정상 거부하지만(`admission_service.py` 가 CANCELLED/EXPIRED 를 첫 관문에서 막는다),
 * 화면이 "쓸 수 있는 티켓"처럼 보였다.
 *
 *     손님   "환불했는데 티켓이 살아있네? 들어갈 수 있나?"
 *     현장   QR 스캔 → 거부 → 실랑이
 *
 * **환불한 사람을 현장에 나타나게 만드는 화면**이다. 보안 구멍은 아니지만 대회 당일
 * 게이트에서 스태프가 감당해야 한다.
 *
 * 알림톡 딥링크는 이미 막혀 있었다(`ticket-link-token.ts` 의 열람 허용 = active·used).
 * 뚫려 있던 건 **이름·전화로 조회한 경로** — 상태 검사가 없었다. 하필 환불 직후엔
 * 그 쿠키가 살아 있어서, **환불한 사람이 가장 확실하게 보는 화면**이 그 경로였다.
 *
 * ⟹ 판정을 한 곳에 둔다. 화면마다 따로 적으면 또 갈라진다
 *    (오늘 아침 참석자 필터가 같은 이유로 어긋나 있었다).
 */

/** v2 ticket status 6종. 이 목록을 줄이지 말 것 — 미지값을 조용히 삼키면 못 쓰는 티켓이 열린다. */
export type V2TicketStatus =
  | "pending"
  | "active"
  | "used"
  | "transferred"
  | "cancelled"
  | "expired";

export interface TicketUsability {
  /** QR 을 띄워도 되는가. */
  usable: boolean;
  /** 못 쓰는 이유 — QR 자리에 그대로 노출된다(스태프·구매자가 읽는다). */
  title: string | null;
  /** 다음에 뭘 하면 되는지. */
  detail: string | null;
  /** 목록·상세에 쓰는 한국어 상태 라벨. */
  label: string;
}

/**
 * ⚠️ `used` 와 `pending` 은 **쓸 수 있다**. 실수로 막기 쉬운 자리라 근거를 남긴다.
 *
 *  - `used` — 입장 완료. 그런데 KLPGA 는 **daypass** 라 다음 날 다시 입장한다.
 *    (`admission_service` 는 single/daypass 입장 시 티켓을 USED 로 바꾼다.)
 *    여기서 QR 을 숨기면 **2일차 관객이 티켓을 못 연다.**
 *  - `pending` — 무통장 확정이 **비동기 outbox** 라 발권 직후 잠시 pending 이다.
 *    게이트도 PENDING 을 받아준다(`checkin_service.py:220`). 여기서 막으면
 *    무통장 구매자가 입장 직전에 티켓을 못 연다.
 */
const USABLE: ReadonlySet<string> = new Set<V2TicketStatus>(["pending", "active", "used"]);

const NOTICE: Record<string, { title: string; detail: string; label: string }> = {
  cancelled: {
    title: "환불·취소된 티켓입니다",
    detail: "입장하실 수 없습니다. 문의가 필요하시면 주최자에게 연락해주세요.",
    label: "환불·취소",
  },
  expired: {
    title: "기간이 만료된 티켓입니다",
    detail: "사용 기간이 지나 입장하실 수 없습니다.",
    label: "만료",
  },
  transferred: {
    title: "다른 분에게 양도된 티켓입니다",
    detail: "양도 후에는 원래 구매자가 입장하실 수 없습니다.",
    label: "양도됨",
  },
};

const USABLE_LABEL: Record<string, string> = {
  pending: "결제 확인 중",
  active: "사용 가능",
  used: "입장 완료",
};

/**
 * 티켓 상태 → 사용 가능 여부와 화면 문구.
 *
 * 🔴 **미지 상태는 막는다**(fail-closed). v2 가 상태를 하나 추가했는데 여기 안 적히면,
 *    "모르니까 열어준다" 는 **못 쓰는 티켓에 QR 을 띄우는 것**이다. 반대는 문의 한 통이지만
 *    이쪽은 현장 분쟁이다.
 */
export function resolveTicketUsability(status: string | null | undefined): TicketUsability {
  const key = String(status ?? "").trim().toLowerCase();
  if (USABLE.has(key)) {
    return { usable: true, title: null, detail: null, label: USABLE_LABEL[key] ?? "사용 가능" };
  }
  const known = NOTICE[key];
  if (known) return { usable: false, ...known };
  return {
    usable: false,
    title: "사용할 수 없는 티켓입니다",
    detail: "상태를 확인할 수 없습니다. 주최자에게 문의해주세요.",
    label: "확인 필요",
  };
}

/** 목록·배지용 한 줄 라벨. 원시 영문 상태값이 화면에 새지 않게 한다. */
export function ticketStatusLabel(status: string | null | undefined): string {
  return resolveTicketUsability(status).label;
}
