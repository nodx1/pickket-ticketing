"""🔴 등급별 판매창 (2026-08-20 대회 중).

행사 단위 창 하나로는 등급마다 다른 마감을 못 맞춘다. 늦은 쪽에 맞추면
**끝난 등급이 계속 팔리고**, 이른 쪽에 맞추면 살아있는 등급이 막힌다.
KLPGA: 주중권 8/21 12시 · 주말권 8/23 12시.
"""
from datetime import datetime, timedelta, timezone

from app.core.commerce_status import evaluate_tier_sale_window

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 8, 20, 10, 0, tzinfo=KST)


def _g(opens=None, closes=None, now=NOW):
    return evaluate_tier_sale_window(
        tier_name="주중권", bidding_opens_at=opens, bidding_closes_at=closes, now=now
    )


def test_no_window_means_no_limit():
    """⚠️ 창이 없으면 제한 없음 — 등급 창을 안 넣은 행사가 이 변경으로 막히면 안 된다."""
    assert _g().ok is True


def test_open_before_close():
    assert _g(closes=datetime(2026, 8, 21, 12, 0, tzinfo=KST)).ok is True


def test_closed_after_deadline():
    """🔴 마감 시각이 지나면 못 산다."""
    r = _g(
        closes=datetime(2026, 8, 21, 12, 0, tzinfo=KST),
        now=datetime(2026, 8, 21, 12, 0, 1, tzinfo=KST),
    )
    assert r.ok is False
    assert r.code == "TIER_SALES_WINDOW_CLOSED"
    assert "주중권" in r.message_ko, "어느 등급이 마감인지 손님이 알아야 한다"


def test_boundary_is_closed_at_exact_time():
    """경계 — 12:00 정각은 마감이다(>= 로 판정)."""
    t = datetime(2026, 8, 21, 12, 0, tzinfo=KST)
    assert _g(closes=t, now=t).ok is False


def test_not_open_yet():
    r = _g(opens=datetime(2026, 8, 22, 0, 0, tzinfo=KST))
    assert r.ok is False
    assert r.code == "TIER_SALES_WINDOW_NOT_OPEN"


def test_naive_datetime_treated_as_utc():
    """⚠️ tz 없는 값이 와도 UTC 로 읽는다 — 안 그러면 9시간 어긋난다."""
    assert _g(closes=datetime(2026, 8, 21, 3, 0)).ok is True
    assert _g(closes=datetime(2026, 8, 20, 0, 0)).ok is False


def test_order_creation_calls_tier_gate():
    """🔴 배선 — 순수함수가 옳아도 주문 생성이 안 부르면 소용없다.

    같은 주에 화면 배선이 끊겨 프로덕션이 조용히 옛 동작을 하던 일이 두 번 있었다.
    """
    src = open("app/api/v1/internal_commerce.py", encoding="utf-8").read()
    assert "evaluate_tier_sale_window(" in src, "주문 생성이 등급 게이트를 안 부른다"
    # 티어를 잠근 **뒤**에 검사해야 한다 — 그래야 실제 구매 대상 등급을 본다.
    i_lock = src.index("with_for_update()")
    i_gate = src.index("evaluate_tier_sale_window(", i_lock)
    assert i_gate > i_lock, "등급 잠금 전에 검사하면 엉뚱한 등급을 본다"
    # 거부를 삼키지 않는다.
    tail = src[i_gate : i_gate + 600]
    assert "_tier_gate.ok" in tail and "raise ApiError" in tail, "거부가 조용히 무시된다"


def test_tier_gate_applies_to_customer_paths_only():
    """🔴 주최자 발권은 막지 않는다 (2026-08-20).

    같은 파일 :4270 이 남긴 교훈 — 게이트를 `_do_create_order` 전체에 걸면
    go 의 self 주문이 죽는다("KLPGA 가 정확히 그 경우다"). 마감 뒤에 분실 재발권·
    현장 보정을 못 하면 그건 게이트가 아니라 사고다.
    """
    from app.api.v1.internal_commerce import _TIER_WINDOW_SOURCES

    assert "guest_public" in _TIER_WINDOW_SOURCES, "공개 구매가 안 막힌다"
    assert "go" in _TIER_WINDOW_SOURCES, "go 체크아웃이 안 막힌다 — 실판매가 안 멈춘다"
    # 🔴 주최자 내부 경로(초대권·수동발권)는 빠져 있어야 한다.
    assert "internal" not in _TIER_WINDOW_SOURCES
    assert "organizer" not in _TIER_WINDOW_SOURCES

    src = open("app/api/v1/internal_commerce.py", encoding="utf-8").read()
    i = src.index("evaluate_tier_sale_window(", src.index("with_for_update()"))
    head = src[max(0, i - 400) : i]
    assert "_TIER_WINDOW_SOURCES" in head, "출처 판별 없이 전체에 걸렸다"
