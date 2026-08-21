"""커머스 status 단일 출처(H1·M4) 정합 — 투영 맵이 전 v2 enum을 커버 + 계약 정렬."""
from datetime import datetime, timedelta, timezone

from app.core.commerce_status import (
    EVENT_STATUS_V2_TO_GO, ORDER_STATUS_V2_TO_GO,
    GO_EVENT_STATUSES, project_event_status, project_order_status,
    PURCHASABLE_EVENT_STATUSES, evaluate_purchase_gate,
)
from app.models.event import EventStatus
from app.models.order import OrderStatus


def test_event_projection_covers_all_v2_statuses():
    # go 는 **6-상태**다(status-machine.ts EventStatus / constants.EVENT_STATUS).
    # 2026-07-27 이전엔 이 단언이 4-상태였고, 그래서 심사 상태가 draft 로 뭉개지는 결함을
    # 테스트가 오히려 **고정**하고 있었다.
    go_states = {"draft", "pending_review", "rejected", "live", "archived"}
    for s in EventStatus:
        assert s.value in EVENT_STATUS_V2_TO_GO, f"event status {s.value} 투영 누락"
        assert EVENT_STATUS_V2_TO_GO[s.value] in go_states


def test_review_states_survive_projection():
    """🔴 실결함 회귀(2026-07-27 prod).

    심사 상태를 draft 로 뭉개면 주최자는 (a) 요청이 접수됐는지 알 수 없고
    (b) 반려돼도 그 사실이 화면에서 사라진다. 컷오버로 v2 가 유일한 출처가 된 뒤
    이 투영이 곧 주최자가 보는 상태다.
    """
    assert EVENT_STATUS_V2_TO_GO["pending_review"] == "pending_review"
    assert EVENT_STATUS_V2_TO_GO["under_review"] == "pending_review"  # 주최자 관점 동일
    assert EVENT_STATUS_V2_TO_GO["revision_requested"] == "rejected"
    assert EVENT_STATUS_V2_TO_GO["draft"] == "draft"


def test_order_status_enum_matches_db_check_allowed_set():
    """드리프트 가드(P0 재발방지): OrderStatus enum ≡ ck_orders_status CHECK 허용집합.

    dom_enum_0601 이 enum 에 partially_refunded 를 추가하면서 CHECK(ck_orders_status)를
    안 고쳐 부분환불이 23514 로 500 났음. enum 값을 추가/삭제하면 이 테스트가 깨지므로
    → 반드시 ck_orders_status 마이그(ord_partial_refund_check_0603 패턴)도 동반 갱신할 것.
    """
    # ord_partial_refund_check_0603._STATUSES 와 동일해야 함(DB CHECK 정본).
    db_check_allowed = {
        "pending", "payment_required", "authorized", "paid", "confirmed",
        "cancelled", "expired", "refunded", "partially_refunded",
        "deposit_held", "deposit_refunded", "deposit_forfeited",
    }
    enum_values = {s.value for s in OrderStatus}
    assert enum_values == db_check_allowed, (
        f"OrderStatus enum 과 ck_orders_status CHECK 불일치. "
        f"enum에만: {enum_values - db_check_allowed}, CHECK에만: {db_check_allowed - enum_values}. "
        f"enum 변경 시 ck_orders_status 마이그레이션도 갱신 필요."
    )


def test_order_projection_covers_all_v2_statuses():
    for s in OrderStatus:
        assert s.value in ORDER_STATUS_V2_TO_GO, f"order status {s.value} 투영 누락"
    assert set(ORDER_STATUS_V2_TO_GO.values()) <= {
        "pending", "completed", "cancelled", "refunded", "partially_refunded", "expired",
    }


def test_deposit_forfeited_aligns_to_contract():
    """계약(order-status.ts V2_TO_GO_MAP): deposit_forfeited→cancelled (이전 read=expired 불일치 수정)."""
    assert ORDER_STATUS_V2_TO_GO["deposit_forfeited"] == "cancelled"
    assert project_order_status(OrderStatus.DEPOSIT_FORFEITED) == "cancelled"


def test_partially_refunded_projection():
    assert project_order_status(OrderStatus.PARTIALLY_REFUNDED) == "partially_refunded"


def test_event_projection_helper():
    assert project_event_status(EventStatus.APPROVED) == "live"
    assert project_event_status(EventStatus.COMPLETED) == "archived"
    assert "paused" in GO_EVENT_STATUSES  # go-native(status-독립 sales_paused로 투영)


def test_sales_paused_projects_to_paused_only_over_live():
    """go 'paused'(주최자 판매 일시중지) = sales_paused 플래그 + 투영 'live' 구간일 때만 덮어씀.

    status를 건드리지 않으므로(재개=플래그 해제로 직전 상태 복원) draft/archived는 paused 무의미.
    """
    # live 구간(approved~allocated) + paused → "paused"
    for s in (EventStatus.APPROVED, EventStatus.BIDDING_OPEN,
              EventStatus.BIDDING_CLOSED, EventStatus.ALLOCATING, EventStatus.ALLOCATED):
        assert project_event_status(s, sales_paused=True) == "paused", s
        assert project_event_status(s, sales_paused=False) == "live", s
    # draft/archived 구간은 paused 무시(애초에 판매중 아님)
    assert project_event_status(EventStatus.DRAFT, sales_paused=True) == "draft"
    assert project_event_status(EventStatus.CANCELLED, sales_paused=True) == "archived"
    assert project_event_status(EventStatus.COMPLETED, sales_paused=True) == "archived"


def test_single_source_used_by_both_modules():
    """internal_commerce 와 read 가 동일 객체를 참조(중복 정의 제거 확인)."""
    from app.api.v1 import internal_commerce as ic
    from app.api.v1 import internal_commerce_read as icr
    assert ic._EVENT_STATUS_V2_TO_GO is EVENT_STATUS_V2_TO_GO
    assert icr._ORDER_STATUS_V2_TO_GO is ORDER_STATUS_V2_TO_GO
    assert ic._REVENUE_STATUSES is icr._REVENUE_STATUSES


# ── U4 판매게이트 SSOT 골든(순수함수) ─────────────────────────────────────

def _win(now=None):
    now = now or datetime.now(timezone.utc)
    return dict(
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=7),
    )


def test_purchasable_set_is_single_source_for_purchase_service():
    """판매가능 집합이 commerce_status SSOT ≡ purchase_service.PURCHASABLE_STATUSES."""
    from app.services import purchase_service
    assert purchase_service.PURCHASABLE_STATUSES is PURCHASABLE_EVENT_STATUSES
    assert PURCHASABLE_EVENT_STATUSES == frozenset(
        {EventStatus.APPROVED, EventStatus.BIDDING_OPEN, EventStatus.ALLOCATED}
    )


def test_gate_allows_purchasable_statuses_in_window():
    for s in PURCHASABLE_EVENT_STATUSES:
        r = evaluate_purchase_gate(status=s, sales_paused=False, **_win())
        assert r.ok is True, s


def test_gate_blocks_non_purchasable_statuses():
    """draft·pending_review·bidding_closed·completed 등은 판매창이 열려 있어도 차단."""
    for s in (
        EventStatus.DRAFT, EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW,
        EventStatus.REVISION_REQUESTED, EventStatus.BIDDING_CLOSED,
        EventStatus.ALLOCATING, EventStatus.COMPLETED,
    ):
        r = evaluate_purchase_gate(status=s, sales_paused=False, **_win())
        assert r.ok is False and r.code == "EVENT_NOT_PURCHASABLE", s


def test_gate_cancelled_takes_priority():
    r = evaluate_purchase_gate(status=EventStatus.CANCELLED, sales_paused=False, **_win())
    assert r.ok is False and r.code == "EVENT_CANCELLED" and r.http_status == 409


def test_gate_paused_over_purchasable():
    """paused 는 status-독립(가역) — 판매가능 상태여도 차단, code=SALES_PAUSED."""
    r = evaluate_purchase_gate(status=EventStatus.BIDDING_OPEN, sales_paused=True, **_win())
    assert r.ok is False and r.code == "SALES_PAUSED"


def test_gate_window_not_open_and_closed():
    now = datetime.now(timezone.utc)
    # 아직 개시 전
    r1 = evaluate_purchase_gate(
        status=EventStatus.BIDDING_OPEN, sales_paused=False,
        bidding_opens_at=now + timedelta(hours=1),
        bidding_closes_at=now + timedelta(days=7),
    )
    assert r1.ok is False and r1.code == "SALES_WINDOW_NOT_OPEN"
    # 이미 종료
    r2 = evaluate_purchase_gate(
        status=EventStatus.BIDDING_OPEN, sales_paused=False,
        bidding_opens_at=now - timedelta(days=7),
        bidding_closes_at=now - timedelta(hours=1),
    )
    assert r2.ok is False and r2.code == "SALES_WINDOW_CLOSED"


def test_gate_naive_datetime_treated_as_utc():
    """tz-naive window 도 UTC 로 간주(purchase_service 와 정렬) — 크래시/오판 금지."""
    now = datetime.now(timezone.utc)
    r = evaluate_purchase_gate(
        status=EventStatus.BIDDING_OPEN, sales_paused=False,
        bidding_opens_at=(now - timedelta(days=1)).replace(tzinfo=None),
        bidding_closes_at=(now + timedelta(days=1)).replace(tzinfo=None),
    )
    assert r.ok is True


def test_gate_null_window_allows():
    """window NULL(무제한) 이면 status·paused 만으로 판정 — window 게이팅 스킵."""
    r = evaluate_purchase_gate(
        status=EventStatus.BIDDING_OPEN, sales_paused=False,
        bidding_opens_at=None, bidding_closes_at=None,
    )
    assert r.ok is True


# ── 참석자 상태 투영 — go `domain-model.ts` 와 **같은 표**여야 한다 ──────────
# 두 언어에 표가 한 벌씩 있으므로, 양쪽에 **같은 기대값을 직접 박아** 갈라짐을 잡는다.
# (go 쪽 대응: organizer `src/lib/attendees/attendee-status-filter.guard.test.ts`)
def test_attendee_projection_matches_go_domain_model():
    from app.core.commerce_status import TICKET_STATUS_V2_TO_GO_ATTENDEE

    assert TICKET_STATUS_V2_TO_GO_ATTENDEE == {
        "pending": "pending",
        "active": "confirmed",
        "used": "confirmed",
        "transferred": "confirmed",
        "cancelled": "cancelled",
        "expired": "cancelled",
    }


def test_attendee_reverse_is_computed_not_handwritten():
    """🔴 N:1 역상 — 손으로 뒤집으면 expired 를 놓친다(취소 필터 0건의 원인)."""
    from app.core.commerce_status import attendee_go_to_v2_list

    assert sorted(attendee_go_to_v2_list("cancelled")) == ["cancelled", "expired"]
    assert sorted(attendee_go_to_v2_list("confirmed")) == ["active", "transferred", "used"]
    # checked_in 은 status 컬럼이 아니라 checked_in_at 파생 → 역상이 비어야 한다.
    assert attendee_go_to_v2_list("checked_in") == []


def test_every_v2_ticket_status_is_projected():
    """미지값을 `?? pending` 으로 흘리면 입장 완료(used)가 「대기」로 떨어진다."""
    from app.models.ticket import TicketStatus
    from app.core.commerce_status import TICKET_STATUS_V2_TO_GO_ATTENDEE

    missing = [s.value for s in TicketStatus if s.value not in TICKET_STATUS_V2_TO_GO_ATTENDEE]
    assert not missing, f"투영표에 없는 v2 ticket status: {missing}"
