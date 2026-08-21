export const EVENT_STATUS = [
  "draft",
  "pending_review",
  "rejected",
  "live",
  "paused",
  "archived",
] as const;
export const EVENT_TYPES = [
  // 기존 14종 (Phase 0-4 이전)
  "concert",
  "festival",
  "conference",
  "exhibition",
  "mice",
  "workshop",
  "fan_meeting",
  "flea_market",
  "lecture",
  "preview",
  "local_festival",
  "party",
  "networking",
  "sports",
  // Phase 5 v2 통합 시 확장 10종 (migration 112)
  "musical",
  "theater",
  "comedy",
  "seminar",
  "meetup",
  "webinar",
  "trade_show",
  "charity",
  "awards",
  "screening",
] as const;
export const AGE_RATINGS = ["all", "7+", "12+", "15+", "18+", "custom"] as const;
export const ORDER_STATUS = [
  "pending",
  "completed",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export const PAYMENT_METHOD = [
  "toss",
  "kakaopay",
  "naverpay",
  "card",
  "bank_transfer",
  "offline",
] as const;
// 조직 내 팀 권한. 플랫폼 어드민은 v2 에서 별도 관리.
export const USER_ROLES = ["owner", "admin", "organizer", "staff", "check_in"] as const;
export const PRODUCT_TYPES = ["ticket", "addon", "bundle", "donation"] as const;

export const EVENT_STATUS_LABELS = {
  draft: "초안",
  pending_review: "심사 중",
  rejected: "반려됨",
  live: "판매중",
  paused: "일시중지",
  archived: "보관됨",
} as const;

export const EVENT_TYPE_LABELS = {
  concert: "콘서트",
  festival: "축제",
  conference: "컨퍼런스",
  exhibition: "전시",
  mice: "MICE",
  workshop: "워크숍",
  fan_meeting: "팬미팅",
  flea_market: "플리마켓",
  lecture: "강연/세미나",
  preview: "시사회",
  local_festival: "지역축제",
  party: "파티/전야제",
  networking: "네트워킹",
  sports: "스포츠",
  // Phase 5 v2 통합 확장 10종
  musical: "뮤지컬",
  theater: "연극",
  comedy: "코미디",
  seminar: "세미나",
  meetup: "밋업",
  webinar: "웨비나",
  trade_show: "박람회/전시",
  charity: "자선/기부",
  awards: "시상식",
  screening: "시사/상영회",
} as const;

export const AGE_RATING_LABELS: Record<string, string> = {
  all: "전체관람가",
  "7+": "만 7세 이상",
  "12+": "12세 이상",
  "15+": "15세 이상",
  "18+": "청소년관람불가",
  custom: "직접 입력",
};

/**
 * 주문 상태 라벨 — 🔴 **이벤트 상태 라벨(`EVENT_STATUS_LABELS`)을 쓰지 말 것.**
 *
 * 2026-07-31 prod 실측: 주문 목록이 `completed` 를 `<StatusBadge status="live">` 로 그려
 * **결제 완료된 주문에 「판매중」**, 결제 대기 주문에 「초안」이 떴다. 배지 **색**을
 * 재활용하려다 **라벨까지 따라온** 것이다. 이 표는 그때도 있었는데 안 쓰고 있었다.
 */
export const ORDER_STATUS_LABELS = {
  pending: "결제 대기",
  completed: "결제 완료",
  expired: "만료",
  cancelled: "취소됨",
  refunded: "환불 완료",
  partially_refunded: "부분 환불",
} as const;

export const PAYMENT_METHOD_LABELS = {
  toss: "토스페이먼츠",
  kakaopay: "카카오페이",
  naverpay: "네이버페이",
  card: "신용카드",
  bank_transfer: "무통장입금",
  offline: "현장결제",
  // 🔴 v2→go 전파는 `method` 에 **PG사명**을 싣는다(`payment_service.py` 의
  //    `method=order.pg_provider`). 그래서 카드로 결제해도 go 원장에는 `nicepay` 가
  //    박히는데 라벨이 없어 화면에 **영어 원문 "nicepay"** 가 그대로 노출됐다.
  //
  // ⚠️ **수단이 아니라 PG사명이다.** "카드" 라고 쓰면 안 된다 — 나이스는 가상계좌
  //    (`nice-methods.ts:35` VBANK "가상계좌")도 지원하고 실제로 쓰인 적이 있다.
  //    카드/가상계좌를 구분할 정보가 이 값에는 **없으므로**, 아는 만큼만 말한다.
  //    (근본 수정 = 전파가 정규화 수단을 싣도록. v2 계약 변경이라 대회 후.)
  nicepay: "나이스페이",
  toss_payments: "토스페이먼츠",
  unknown: "미확인",
} as const;

/**
 * 결제수단 표시용 라벨 해석. **원문을 화면에 흘리지 않는다.**
 *
 * 🔴 종전 호출부는 `LABELS[x] ?? String(x)` 였다. 미지값이 그대로 노출되는 구조라
 *    `nicepay` 가 영어로 나갔고, 결제수단 미정(null)이면 문자열 `"null"` 이 찍힌다.
 *
 * `null` = 결제수단 미정. 소비자 체크아웃 시작 시점에는 수단을 모른다 — "현장결제"
 * 라고 단정하면 안 된다(그게 이번 결함이었다).
 */
export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return "미확인";
  return (PAYMENT_METHOD_LABELS as Record<string, string>)[method] ?? "기타";
}

export const PRODUCT_TYPE_LABELS = {
  ticket: "티켓",
  addon: "부가서비스",
  bundle: "상품",
  donation: "후원",
} as const;

export const USER_ROLE_LABELS = {
  owner: "소유자",
  admin: "관리자",
  organizer: "주최자",
  staff: "운영스태프",
  check_in: "체크인전용",
} as const;

export const ATTENDEE_STATUS_LABELS: Record<string, string> = {
  pending: "확정 대기",
  confirmed: "확정",
  checked_in: "체크인 완료",
  cancelled: "취소됨",
};

export const WAITLIST_STATUS_LABELS: Record<string, string> = {
  waiting: "대기 중",
  offered: "구매 제안됨",
  converted: "구매 전환",
  cancelled: "취소됨",
  expired: "만료됨",
};

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  refund_request: "환불 요청",
  sold_out: "매진",
  payment_failed: "결제 실패",
  new_order: "새 주문",
  check_in_milestone: "체크인 현황",
  system: "시스템",
  // mig146 로 확장된 타입 — 라벨 누락 시 원문 노출(크래시는 아님).
  ai_review: "AI 제안 검토",
  ai_complete: "AI 자동 적용",
  event_approved: "이벤트 승인",
  event_rejected: "이벤트 반려",
};

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: "생성",
  update: "수정",
  delete: "삭제",
  login: "로그인",
  export: "내보내기",
};

export const AFFILIATE_STATUS_LABELS: Record<string, string> = {
  active: "활성",
  inactive: "비활성",
};
