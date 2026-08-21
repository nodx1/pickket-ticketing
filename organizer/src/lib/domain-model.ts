/**
 * v2 도메인 모델 로컬 복사본
 *
 * 정본: pickket.v2/docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * 원본: pickket.v2/packages/lib/src/contracts/
 *
 * ⚠️ v2 표준 변경 시 이 파일 동기화 필수 (cross-request로 통보받음)
 * 마지막 동기화: 2026-06-01 (G4 — generated 60종 대조: sale_mode 4종·order/event_status·
 *   category 9종(esports 추가). order_status 상세는 src/lib/v2/order-status-map.ts)
 */

// ── Sale Mode (v3.0 정본) ────────────────────────────────────────

export const SALE_MODES = [
  "fanclub_presale",
  "point_lottery",
  "queue",
  "fixed_fcfs",
] as const;

export type SaleMode = (typeof SALE_MODES)[number];

const LEGACY_SALE_MODE_MAP: Record<string, SaleMode> = {
  lottery: "point_lottery",
  fanclub: "fanclub_presale",
  vcg: "point_lottery",
  dutch: "fixed_fcfs",
  fcfs: "fixed_fcfs",
  // seat_tiers 정규화 어휘(migration 151) → v2 canonical 4종
  fcfs_residual: "fixed_fcfs",
  queue_sale: "queue",
  membership_presale: "fanclub_presale",
};

export function toCanonicalSaleMode(raw: string): SaleMode {
  if (SALE_MODES.includes(raw as SaleMode)) return raw as SaleMode;
  return LEGACY_SALE_MODE_MAP[raw] ?? "fixed_fcfs";
}

export const SALE_MODE_LABELS: Record<SaleMode, { ko: string; en: string }> = {
  fanclub_presale: { ko: "멤버십 선판매", en: "Members Presale" },
  point_lottery: { ko: "공정 추첨", en: "Fair Lottery" },
  queue: { ko: "대기열 판매", en: "Queue Sale" },
  fixed_fcfs: { ko: "잔여 선착순", en: "First Come First Served" },
};

// ── Event Status 투영 ─────────────────────────────────────────────

/** v2 EventStatus (SSOT) — go는 4-상태 투영만 사용 */
export const V2_EVENT_STATUSES = [
  "draft", "pending_review", "under_review", "revision_requested",
  "approved", "bidding_open", "bidding_closed",
  "allocating", "allocated", "completed", "cancelled",
] as const;

export type V2EventStatus = (typeof V2_EVENT_STATUSES)[number];
export type GoEventStatus =
  | "draft"
  | "pending_review"
  | "rejected"
  | "live"
  | "paused"
  | "archived";

/**
 * v2 11-상태 → go 6-상태 투영.
 *
 * 🔴 2026-07-27 실결함 수정: 여기가 `pending_review`/`under_review`/`revision_requested` 를
 *    전부 **`draft` 로 뭉개고** 있었다. go 가 자체 `events.status` 컬럼을 갖고 있던 시절에는
 *    이 투영이 "참고용 표시"였지만, 레벨2 컷오버로 **v2 가 상태의 유일한 출처**가 되면서
 *    주최자 화면이 심사 상태를 완전히 잃었다:
 *      · 심사 요청(draft→pending_review)이 v2 에 정상 저장돼도 화면은 계속 `draft`
 *        → 주최자는 요청이 들어갔는지 알 수 없고 버튼을 반복해서 누른다(실제로 재현됨).
 *      · 반려(revision_requested)도 `draft` 로 보여 **반려 사실 자체가 화면에서 사라진다**.
 *    go 의 상태머신·EVENT_STATUS 상수는 애초에 6-상태(`pending_review`·`rejected` 포함)라
 *    투영만 4-상태였던 것이 불일치였다.
 *
 * `under_review`(v2 심사 진행중)는 go 에 대응 상태가 없어 `pending_review` 로 합친다 —
 * 주최자 관점에서 "심사 대기"와 "심사 중"은 동일하게 '요청 접수됨'이다.
 */
const V2_TO_GO_EVENT_MAP: Record<V2EventStatus, GoEventStatus> = {
  draft: "draft",
  pending_review: "pending_review",
  under_review: "pending_review",
  revision_requested: "rejected",
  approved: "live",
  bidding_open: "live",
  bidding_closed: "live",
  allocating: "live",
  allocated: "live",
  completed: "archived",
  cancelled: "archived",
};

export function projectToGoEventStatus(v2Status: V2EventStatus): GoEventStatus {
  return V2_TO_GO_EVENT_MAP[v2Status] ?? "draft";
}

/**
 * go event status(constants.EVENT_STATUS 6-값) → v2 11-상태 write 매핑.
 * 정본: 2026-06-03 EVENT-STATUS-WRITE-CONTRACT (v2→go).
 *
 * go 는 status 문자열을 v2 커머스 write API 에 그대로 보내면 안 된다 — v2 는 11-상태 enum 만 받는다.
 *  - draft          → "draft"
 *  - pending_review → "pending_review"
 *  - rejected       → "revision_requested"
 *  - live           → "approved"  (발행=심사완료/공개. 실판매 개시는 sale_window 가 제어 →
 *                      v2 가 opens_at 도달 시 approved→bidding_open 자동전이. bidding_open 직접쓰기 금지)
 *  - paused         → null        (v2 미구현 ⚠️ — write 시 status 필드 생략. 반영 요구되면 v2 enum 확장 협의)
 *  - archived       → "cancelled" (completed 는 v2 가 파생)
 *
 * null 반환 시 호출부는 v2 write payload 에서 status 필드를 **생략**해야 한다(기존 v2 상태 유지).
 */
export function goToV2WriteEventStatus(goStatus: string): V2EventStatus | null {
  switch (goStatus) {
    case "draft":
      return "draft";
    case "pending_review":
      return "pending_review";
    case "rejected":
      return "revision_requested";
    case "live":
      return "approved";
    case "archived":
      return "cancelled";
    case "paused":
      return null; // v2 미구현 — status 생략
    default:
      return null; // 알 수 없는 값 — 안전하게 생략(기존 v2 상태 유지)
  }
}

// ── Order Status 투영 ─────────────────────────────────────────────

/** v2 OrderStatus (SSOT) — go는 6-상태 투영만 사용. 단일 소스(order-status-map.ts 통합). */
export type GoOrderStatus = "pending" | "completed" | "cancelled" | "refunded" | "partially_refunded" | "expired";

/** v2 주문 상태 enum (SSOT 11종). v2 contract 동기화. */
export type V2OrderStatus =
  | "pending" | "payment_required" | "authorized" | "paid" | "confirmed"
  | "cancelled" | "expired" | "refunded"
  | "deposit_held" | "deposit_refunded" | "deposit_forfeited";

/**
 * v2 → go 투영. Record<V2OrderStatus,...> 로 strict 타이핑 → v2 enum 추가 시 컴파일 에러로 누락 차단.
 * - paid/confirmed → completed, payment_required/authorized/deposit_held → pending(미완결)
 * - deposit_refunded → refunded, deposit_forfeited → cancelled
 * ※ partially_refunded 는 v2 상태가 아니라 go 가 refund_amount 로 파생 — projection 입력으로 오지 않음.
 */
const V2_TO_GO_ORDER_MAP: Record<V2OrderStatus, GoOrderStatus> = {
  pending: "pending",
  payment_required: "pending",
  authorized: "pending",
  paid: "completed",
  confirmed: "completed",
  cancelled: "cancelled",
  expired: "expired",
  refunded: "refunded",
  deposit_held: "pending",
  deposit_refunded: "refunded",
  deposit_forfeited: "cancelled",
};

/** v2 OrderStatus 를 go 6-상태로 투영. 미지값은 pending(안전 기본). go-파생 partially_refunded 는 passthrough. */
export function projectToGoOrderStatus(v2Status: string): GoOrderStatus {
  if (v2Status === "partially_refunded") return "partially_refunded";
  return V2_TO_GO_ORDER_MAP[v2Status as V2OrderStatus] ?? "pending";
}

// ── Attendee(=v2 Ticket) Status 투영 ──────────────────────────────────────
/** go 참석자 4-상태 (state-machine). 체크인은 ticket.checked_in_at 으로 별도 파생. */
export type GoAttendeeStatus = "pending" | "confirmed" | "cancelled" | "checked_in";

/**
 * v2 ticket status → go 참석자 상태 투영. (v2 ticket SoT, 어휘 불일치 교정)
 *  - active(=발행/유효) → confirmed,  pending → pending,
 *  - cancelled → cancelled,  expired → cancelled
 *  - used(=입장 완료) → confirmed,  transferred(=양도됨) → confirmed
 * ※ checked_in 은 checked_in_at 존재로 호출부에서 우선 파생(여기 입력으로 오지 않음).
 *
 * ## 🔴 v2 TicketStatus 6종을 **빠짐없이** 적는다 (2026-08-01)
 * 예전에는 4종만 적고 나머지는 `?? "pending"` 으로 흘렸다. 그런데 입장 처리는
 * `admission_service` 에서 티켓을 **`used`** 로 바꾼다(daypass/single). KLPGA 는 daypass 다.
 * 즉 **대회 당일 입장한 티켓이 전부 미지값**이 되어 「대기」로 떨어졌을 것이다.
 * (실제로는 같은 트랜잭션에서 `checked_in_at` 도 채워 호출부가 「체크인」으로 덮어써
 *  화면에서는 드러나지 않았다 — 방어가 두 겹이라 **가려져 있었을 뿐**이다.)
 *
 * ⟹ 안전 기본값은 **모르는 상태를 조용히 삼키는 장치**다. 아는 상태는 여기 다 적는다.
 */
const V2_TICKET_TO_GO_ATTENDEE_MAP: Record<string, GoAttendeeStatus> = {
  active: "confirmed",
  pending: "pending",
  cancelled: "cancelled",
  expired: "cancelled",
  // 입장 완료. `checked_in_at` 이 있으면 호출부가 「체크인」으로 덮어쓰므로 여기까지 오는 건
  // 원장만 남고 스칼라가 비워진 예외 경로다 — 그때도 「대기」가 아니라 **유효한 티켓**이다.
  used: "confirmed",
  // 양도 완료. 소유자만 바뀌었을 뿐 입장 가능한 티켓이다.
  transferred: "confirmed",
};

/** v2 ticket status 를 go 참석자 상태로 투영. 미지값은 pending(안전 기본). */
export function projectToGoAttendeeStatus(v2TicketStatus: string): GoAttendeeStatus {
  return V2_TICKET_TO_GO_ATTENDEE_MAP[v2TicketStatus] ?? "pending";
}

/**
 * go 참석자 상태 → v2 ticket status 집합. **위 투영표의 정확한 역상**이다.
 *
 * ## 🔴 왜 표를 뒤집어 쓰지 않고 파생하는가
 * 목록 필터가 `cancelled → cancelled` 1:1 로만 매핑돼 있었다. 투영은 `expired` 도
 * `cancelled` 로 보내는 **N:1** 인데 역방향만 1:1 이라, prod 에서 **화면엔 「취소됨」 3건이
 * 보이는데 취소 필터는 0건**이었다(통계 카드도 같은 필터를 호출하므로 같이 0).
 *
 * ⟹ 손으로 적은 역방향 표를 두지 않는다. 투영표에서 **계산**하면 어긋날 수가 없다.
 */
export function goAttendeeStatusToV2Tickets(goStatus: string): string[] {
  return Object.entries(V2_TICKET_TO_GO_ATTENDEE_MAP)
    .filter(([, go]) => go === goStatus)
    .map(([v2]) => v2);
}

// ── Settlement Status 투영 ────────────────────────────────────────────────
/** go 정산 3-상태(프론트 statusMeta) — v2 6-상태(draft|pending_review|reviewed|approved|paid|disputed) 투영. */
export type GoSettlementStatus = "pending" | "processing" | "completed";
const V2_TO_GO_SETTLEMENT_MAP: Record<string, GoSettlementStatus> = {
  draft: "pending",
  pending_review: "pending",
  reviewed: "processing",
  approved: "processing",
  disputed: "processing",
  paid: "completed",
};
/** v2 정산상태 → go 3-상태. 미지값 pending. (go 프론트 크래시 방지 — raw v2 status 직접 노출 금지) */
export function projectToGoSettlementStatus(v2Status: string): GoSettlementStatus {
  return V2_TO_GO_SETTLEMENT_MAP[v2Status] ?? "pending";
}
/** go 정산 3-상태 → v2 write 상태(PATCH). completed→paid 확정, 나머지 근사. */
export function goToV2SettlementStatus(goStatus: string): string {
  const map: Record<string, string> = { completed: "paid", processing: "approved", pending: "draft" };
  return map[goStatus] ?? "draft";
}

// ── Category ↔ EventType 매핑 ─────────────────────────────────────

/** v2 카테고리 (9종, 소비자 검색용 — v2 SSOT, generated/category.ts 동기화) */
export type V2Category =
  | "concert" | "musical" | "sports" | "classical"
  | "exhibition" | "festival" | "esports" | "education" | "civic";

/** go eventType → v2 category 매핑 */
export const EVENT_TYPE_TO_CATEGORY: Record<string, V2Category> = {
  concert: "concert",
  fan_meeting: "concert",
  festival: "festival",
  local_festival: "festival",
  party: "festival",
  conference: "education",
  lecture: "education",
  workshop: "education",
  mice: "exhibition",
  exhibition: "exhibition",
  preview: "exhibition",
  flea_market: "exhibition",
  trade_show: "exhibition",
  screening: "exhibition",
  networking: "civic",
  meetup: "civic",
  charity: "civic",
  // Phase 5 확장 event_type — 미매핑 시 "exhibition" 폴백으로 스포츠·공연이 마켓에서 전시로
  // 오분류되던 버그 수정(예: sports 골프 → EXHIBITION). go EVENT_TYPES(24종) 전수 매핑.
  sports: "sports",
  musical: "musical",
  theater: "musical",
  comedy: "concert",
  awards: "concert",
  seminar: "education",
  webinar: "education",
};

export function toV2Category(eventType: string): V2Category {
  return EVENT_TYPE_TO_CATEGORY[eventType] ?? "exhibition";
}
