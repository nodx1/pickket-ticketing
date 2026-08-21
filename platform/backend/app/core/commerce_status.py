"""커머스 status 집계·투영 단일 출처 (H1·M4).

여러 internal API 모듈에 흩어져 있던 매출/판매 집계 status set + go 투영 맵을 한 곳에.
go 투영은 `packages/lib/src/contracts/{event,order}-status.ts` V2_TO_GO_MAP 과 정렬.

⚠️ 계약(TS) 동기화 주의: TS order V2_TO_GO_MAP 은 `partially_refunded` 키가 누락된
stale 상태(dom_enum_0601 에서 v2 enum 추가됨). 여기선 partially_refunded→partially_refunded
로 올바르게 두되, **TS 계약 맵 갱신은 flip 후 조율 윈도우에서**(go/app 작업 중 공유계약 변경 회피).
"""
from datetime import datetime, timezone
from typing import NamedTuple

from app.models.event import EventStatus
from app.models.order import OrderStatus
from app.models.seat import SeatStatus

# ── 판매게이트 SSOT (U4 — go 폐기 대비) ───────────────────────────────────
# 판매 가능(구매 진입 허용) 이벤트 status 의 **단일 정의**. 여기가 v2 SSOT 다.
#   - purchase_service(consumer marketplace 경로)
#   - internal_commerce._do_create_order(go write-through·consumer 게스트 경로)
# 둘 다 이 집합을 import 해서 판정 → go 가 폐기돼도 v2 가 판매 게이트를 단독 판정.
# ⚠️ 채널판정(marketplace vs self)은 이 게이트 밖 별도(SALE-STATE-SYNC §1.2).
#   이 집합은 **채널-무관**: 어느 진입점이든 이 status·window·paused 를 통과해야 한다.
PURCHASABLE_EVENT_STATUSES = frozenset(
    {EventStatus.APPROVED, EventStatus.BIDDING_OPEN, EventStatus.ALLOCATED}
)


class PurchaseGateResult(NamedTuple):
    """판매게이트 판정 결과. 순수함수 — DB write·auto-transition 부수효과 없음.

    ok=True 면 구매 진입 허용. ok=False 면 (code, message_ko, http_status) 로 거부.
    호출측이 각자의 에러 타입(ApiError·PurchaseError)으로 매핑.
    """

    ok: bool
    code: str = ""
    message_ko: str = ""
    http_status: int = 409


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def evaluate_tier_sale_window(
    *,
    tier_name: str,
    bidding_opens_at: datetime | None,
    bidding_closes_at: datetime | None,
    now: datetime | None = None,
) -> PurchaseGateResult:
    """🔴 등급별 판매창 (2026-08-20 대회 중 추가).

    ## 왜 필요한가

    종전 게이트는 **행사 단위 창**만 봤다. KLPGA 는 등급마다 마감이 다르다 —
    주중권은 8/21 12시, 주말권은 8/23 12시. 행사 창 하나로는 둘 중 하나만 맞출 수
    있고, 늦은 쪽에 맞추면 **끝난 등급이 계속 팔린다**.

    ⚠️ 값이 없으면(None) 제한이 없다 — 종전 동작 그대로다. 등급에 창을 안 넣은
       행사가 이 변경으로 막히면 안 된다.
    ⚠️ 행사 창과 **함께** 적용된다. 둘 중 하나라도 닫혀 있으면 못 산다.
    """
    now = now or datetime.now(timezone.utc)
    opens_at = _as_utc(bidding_opens_at)
    closes_at = _as_utc(bidding_closes_at)
    if opens_at is not None and now < opens_at:
        return PurchaseGateResult(
            False, "TIER_SALES_WINDOW_NOT_OPEN", f"{tier_name} 판매 시작 전입니다.", 409
        )
    if closes_at is not None and now >= closes_at:
        return PurchaseGateResult(
            False, "TIER_SALES_WINDOW_CLOSED", f"{tier_name} 판매가 마감되었습니다.", 409
        )
    return PurchaseGateResult(True, None, None, 200)


def evaluate_purchase_gate(
    *,
    status,
    sales_paused: bool,
    bidding_opens_at: datetime | None,
    bidding_closes_at: datetime | None,
    now: datetime | None = None,
) -> PurchaseGateResult:
    """채널-무관 판매게이트 (U4 SSOT). 순수함수 — 부수효과 없음.

    검증 순서(= purchase_service._validate_event_purchasable 와 정렬):
      1) CANCELLED           → EVENT_CANCELLED
      2) sales_paused        → SALES_PAUSED (status-독립 가역 플래그)
      3) status ∈ 판매가능    → EVENT_NOT_PURCHASABLE
      4) 판매창(opens/closes) → SALES_WINDOW_NOT_OPEN / SALES_WINDOW_CLOSED

    ⚠️ APPROVED→BIDDING_OPEN auto-transition 은 **여기서 하지 않는다**(순수함수).
       APPROVED 는 판매가능 집합에 포함하되 window 로 게이팅 → 창 열리면 통과.
       실제 status flip 은 marketplace 경로(purchase_service)의 부수효과이며, go/게스트
       원자주문 경로는 flip 없이 "허용/차단"만 판정하면 된다(판매 게이트 목적 달성).
    """
    now = now or datetime.now(timezone.utc)
    st = status.value if hasattr(status, "value") else str(status)

    if st == EventStatus.CANCELLED.value:
        return PurchaseGateResult(False, "EVENT_CANCELLED", "취소된 행사입니다.", 409)
    if sales_paused is True:
        return PurchaseGateResult(
            False, "SALES_PAUSED", "판매가 일시 중지된 행사입니다.", 409
        )
    if st not in {s.value for s in PURCHASABLE_EVENT_STATUSES}:
        return PurchaseGateResult(
            False,
            "EVENT_NOT_PURCHASABLE",
            "현재 판매 중이 아닌 행사입니다.",
            409,
        )

    opens_at = _as_utc(bidding_opens_at)
    if opens_at is not None and now < opens_at:
        return PurchaseGateResult(
            False, "SALES_WINDOW_NOT_OPEN", "아직 판매가 시작되지 않았습니다.", 409
        )
    closes_at = _as_utc(bidding_closes_at)
    if closes_at is not None and now > closes_at:
        return PurchaseGateResult(
            False, "SALES_WINDOW_CLOSED", "판매가 종료된 행사입니다.", 409
        )
    return PurchaseGateResult(True)


# ── 집계 status set ──────────────────────────────────────────────────────

# 매출(gross) 집계 대상 — net = gross − refund_amount(rev2). REFUNDED 유지.
REVENUE_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.PAID,
    OrderStatus.PARTIALLY_REFUNDED,
    OrderStatus.REFUNDED,
]
# 판매수량(soldCount) 대상 — 환불분 제외(refunded 빠짐).
SOLD_QTY_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.PAID,
    OrderStatus.PARTIALLY_REFUNDED,
]
# 좌석 판매 카운트(go 계약: reserved+sold). reserved=organizer block 이지만 go 정의 따름.
SOLD_SEAT_STATUSES = [SeatStatus.RESERVED, SeatStatus.SOLD]

# NOTE: finance_service._PAID_STATUSES = (PAID, CONFIRMED) 는 **관리자 정산 모수**로
# 의도적으로 다름(partially_refunded/refunded 제외). go read-cluster net_revenue 모수
# (REVENUE_STATUSES)와 구분 — 혼동 금지.

# ── go 투영 맵 (TS 계약 정렬) ────────────────────────────────────────────

# event v2 11-상태 → go 6-상태 (go status-machine.ts EventStatus / constants.EVENT_STATUS).
#
# 🔴 2026-07-27 prod 실검증에서 수정. 여기가 `pending_review`/`under_review`/
#    `revision_requested` 를 전부 **`draft` 로 뭉개고** 있었다.
#    go 가 자체 `events.status` 컬럼을 갖던 시절엔 이 투영이 "참고용 표시"였지만, 레벨2 컷오버로
#    **v2 가 상태의 유일한 출처**가 되면서 주최자 화면이 심사 상태를 완전히 잃었다:
#      · 심사 요청(draft→pending_review)이 v2 에 정상 저장돼도(200 success) 화면은 계속 `draft`
#        → 주최자는 요청이 접수됐는지 알 수 없어 버튼을 반복해 누른다(prod 에서 재현).
#      · 반려(revision_requested)도 `draft` 로 보여 **반려 사실 자체가 화면에서 사라진다**
#        — 반려 사유 UI 는 있는데 상태가 draft 라 왜 게시가 안 되는지 알 수 없다.
#    go 의 상태머신·EVENT_STATUS 상수는 **애초에 6-상태**(pending_review·rejected 포함)였다.
#    투영만 4-상태였던 것이 불일치였다.
#
#    `under_review`(심사 진행중)는 go 에 대응 상태가 없어 `pending_review` 로 합친다 —
#    주최자 관점에서 "심사 대기"와 "심사 중"은 동일하게 '요청 접수됨'이다.
EVENT_STATUS_V2_TO_GO: dict[str, str] = {
    "draft": "draft",
    "pending_review": "pending_review",
    "under_review": "pending_review",
    "revision_requested": "rejected",
    "approved": "live",
    "bidding_open": "live",
    "bidding_closed": "live",
    "allocating": "live",
    "allocated": "live",
    "completed": "archived",
    "cancelled": "archived",
}
GO_EVENT_STATUSES = {"draft", "pending_review", "rejected", "live", "paused", "archived"}

# order v2 12-상태 → go 6-상태 (order-status.ts V2_TO_GO_MAP + partially_refunded).
ORDER_STATUS_V2_TO_GO: dict[str, str] = {
    "pending": "pending",
    "payment_required": "pending",
    "authorized": "pending",
    "paid": "completed",
    "confirmed": "completed",
    "cancelled": "cancelled",
    "expired": "expired",
    "refunded": "refunded",
    "partially_refunded": "partially_refunded",
    "deposit_held": "pending",
    "deposit_refunded": "refunded",
    "deposit_forfeited": "cancelled",  # 계약 정렬(이전 read=expired 불일치 수정)
}


def _enum_value(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def project_event_status(v2_status, sales_paused: bool = False) -> str:
    go = EVENT_STATUS_V2_TO_GO.get(_enum_value(v2_status), "draft")
    # 판매 일시중지는 status-독립 플래그. go투영이 "live"인 동안만 "paused"로 덮어쓴다
    # (draft/archived는 애초에 판매 중이 아니므로 paused 무의미). → 라운드트립 보장.
    if sales_paused and go == "live":
        return "paused"
    return go


def event_go_to_v2_list(go_status: str) -> list[str]:
    return [v2 for v2, go in EVENT_STATUS_V2_TO_GO.items() if go == go_status]


# ── go → v2 event status WRITE 역매핑 (발행/일시중지 write-through) ────────
# 정본: 레거시 events/sync GO_STATUS_TO_V2_STATUS + DOMAIN_MODEL_STANDARD.
# go "live"=발행=v2 bidding_open(판매창이 시점 추가게이팅). "paused"=status-독립 플래그
# (sales_paused) — status 안 건드림(재개=플래그 해제로 직전상태 복원). "archived"=cancelled.
_V2_EVENT_VALUES = {s.value for s in EventStatus}
EVENT_STATUS_GO_TO_V2: dict[str, str] = {
    "draft": "draft",
    "live": "bidding_open",
    "archived": "cancelled",
    # 레거시/명시 go 워크플로 status (events/sync 호환)
    "pending_review": "pending_review",
    "under_review": "under_review",
    "approved": "approved",
    "rejected": "revision_requested",
    "completed": "allocated",
    "cancelled": "cancelled",
    "deleted": "cancelled",
}


def resolve_event_status_write(raw: str):
    """go status(또는 v2 status) → (v2_status|None, sales_paused|None).

    - v2 status 그대로 → (status, None)  # sales_paused 미변경(별도 필드가 담당)
    - "paused" → (None, True)            # status 유지 + 일시중지 플래그
    - go 4-상태/레거시 → (매핑 v2, False)
    None status = 호출측이 현재값 유지(patch) 또는 기본값 사용(create).
    invalid → ValueError(caller → VALIDATION_ERROR).
    """
    sv = (raw or "").strip().lower()
    if sv in _V2_EVENT_VALUES:
        return (sv, None)
    if sv == "paused":
        return (None, True)
    if sv in EVENT_STATUS_GO_TO_V2:
        return (EVENT_STATUS_GO_TO_V2[sv], False)
    raise ValueError(f"invalid event status: {raw}")


def project_order_status(v2_status) -> str:
    return ORDER_STATUS_V2_TO_GO.get(_enum_value(v2_status), "pending")


def order_go_to_v2_list(go_status: str) -> list[str]:
    return [v2 for v2, go in ORDER_STATUS_V2_TO_GO.items() if go == go_status]


# ── ticket(=참석자) v2 6-상태 → go 참석자 4-상태 ──────────────────────────
# 정본 대응: organizer `src/lib/domain-model.ts` 의 V2_TICKET_TO_GO_ATTENDEE_MAP.
#
# ⚠️ go 참석자 상태 "checked_in" 은 **이 표에 없다.** 그것은 status 컬럼이 아니라
#    `tickets.checked_in_at` 존재 여부에서 파생하며, 표시에서 status 투영을 **덮어쓴다**.
#    필터도 같은 우선순위를 따라야 한다 — `attendee_ticket_filter()` 를 쓸 것.
TICKET_STATUS_V2_TO_GO_ATTENDEE: dict[str, str] = {
    "pending": "pending",
    "active": "confirmed",
    "used": "confirmed",         # 입장 완료(admission_service: daypass/single → USED)
    "transferred": "confirmed",  # 양도 — 소유자만 바뀐 유효 티켓
    "cancelled": "cancelled",
    "expired": "cancelled",      # 🔴 N:1 — 역방향을 1:1 로 적으면 취소 필터가 이걸 놓친다
}
GO_ATTENDEE_STATUSES = {"pending", "confirmed", "cancelled", "checked_in"}


def project_attendee_status(v2_ticket_status) -> str:
    """v2 ticket status → go 참석자 상태. (checked_in 은 호출부가 우선 파생)"""
    return TICKET_STATUS_V2_TO_GO_ATTENDEE.get(_enum_value(v2_ticket_status), "pending")


def attendee_go_to_v2_list(go_status: str) -> list[str]:
    """go 참석자 상태 → v2 ticket status 목록. 투영표에서 **계산**한다(손으로 뒤집지 않는다)."""
    return [v2 for v2, go in TICKET_STATUS_V2_TO_GO_ATTENDEE.items() if go == go_status]
