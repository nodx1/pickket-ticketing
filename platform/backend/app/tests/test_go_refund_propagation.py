"""go 환불 전파 hint — 계약 회귀 (2026-08-01 실사고).

🔴 무엇이 문제였나
   go 가 부르는 환불 경로(`_do_refund_order`)는 `RefundService` 를 **쓰지 않는다.**
   그쪽의 hint 생성 코드를 지나가지 않으므로 이 경로는 전파 hint 가 **아예 만들어지지
   않았다.** 카드 취소는 성공하는데 구매자가 환불완료 알림톡을 못 받고 go `attendees`
   도 취소로 투영되지 않았다(실측: 11:15 결제 → 11:16 환불, pg_refund_id 는 있는데
   worker 로그에 order.refunded 0건).

⚠️ v2 자체 알림 경로도 막혀 있다 — `ORGANIZER_MESSAGING_V2_ENABLED` 미설정이고
   NCP 자격증명이 v2 에 없다. 통지가 나갈 길이 아예 없었다.
"""

import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from app.api.v1.internal_commerce import _build_go_refund_hint


def _order(total_refunded=15000, total_amount=15000):
    return SimpleNamespace(
        id=uuid.uuid4(),
        total_refunded=total_refunded,
        total_amount=total_amount,
        status=SimpleNamespace(value="refunded"),
    )


def _refund(amount=15000):
    return SimpleNamespace(
        id=uuid.uuid4(),
        amount=amount,
        pg_refund_id="nodxkr123m01012608011115023164",
        processed_at=datetime.now(timezone.utc),
    )


def test_hint_is_json_serializable():
    """🔴 UUID 를 그대로 실으면 워커가 json.dumps 에서 죽는다(2026-08-01 실사고)."""
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason="구매자 요청")
    json.dumps(hint)


def test_order_id_is_string():
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason=None)
    assert isinstance(hint["order_id"], str)
    assert not isinstance(hint["order_id"], uuid.UUID)


def test_event_name_matches_go_handler():
    """go `state-changed` 가 이 이름으로 분기한다 — 틀리면 조용히 무시된다."""
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason=None)
    assert hint["event"] == "order.refunded"


def test_refund_amount_is_per_refund_and_total_is_cumulative():
    """🔴 둘은 다른 값이다.

    go 원장은 **누계**를 SET 한다. 건별을 쓰면 부분환불 2회째에 누계가 줄어든다.
    """
    order = _order(total_refunded=25000, total_amount=30000)
    hint = _build_go_refund_hint(order, _refund(amount=10000), is_full=False, reason=None)
    assert hint["data"]["refund_amount"] == 10000.0      # 이번 건
    assert hint["data"]["total_refunded"] == 25000.0     # 누계
    assert hint["data"]["refund_amount"] != hint["data"]["total_refunded"]


def test_total_refunded_is_float_not_str():
    """🔴 refund_service 는 str, partial 은 float 이라 갈려 있었다 — float 로 통일."""
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason=None)
    assert isinstance(hint["data"]["total_refunded"], float)


def test_is_full_refund_is_carried():
    """go 가 이 값으로 attendees 취소 cascade 를 건다 — 틀리면 참석자가 안 죽는다."""
    full = _build_go_refund_hint(_order(), _refund(), is_full=True, reason=None)
    partial = _build_go_refund_hint(_order(), _refund(), is_full=False, reason=None)
    assert full["data"]["is_full_refund"] is True
    assert partial["data"]["is_full_refund"] is False


def test_reason_is_clamped():
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason="가" * 500)
    assert len(hint["data"]["reason"]) == 200


def test_reason_none_is_empty_string():
    hint = _build_go_refund_hint(_order(), _refund(), is_full=True, reason=None)
    assert hint["data"]["reason"] == ""
