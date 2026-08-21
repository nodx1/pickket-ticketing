"""입장일 게이트 회귀 — 2026-07-28 prod E2E 에서 실측된 결함 2건.

① single 모드 티켓이 **다음날에도 입장**됐다(멱등이 per-day 원장이라 날짜가 바뀌면
   '오늘 원장 없음' → 신규 입장 성립). 주중권 1장으로 목·금·토·일 4일 전부 admitted 재현.
② 등급마다 입장 가능일이 다른 대회(주중권=목·금 / 주말권=토·일)를 표현할 수단이 없어
   주중권으로 결승일 입장이 가능했다.

기존 F1 테스트(test_admission_f1.py)의 single 회귀는 **같은 날 재스캔**만 덮었다 —
날짜가 넘어가는 경우를 아무도 보지 않았다.
"""

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.models.event import Event, EventStatus, SeatTier
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.admission_service import AdmissionError, admit, revoke_admission

KST = timezone(timedelta(hours=9))


def _at(y, m, d, hh=10):
    """KST wall-clock → UTC aware (admit 이 내부에서 KST 로 되돌린다)."""
    return datetime(y, m, d, hh, 0, tzinfo=KST).astimezone(timezone.utc)


async def _mk(db, *, admission_mode="single", tier_metadata=None):
    u = User(id=uuid.uuid4(), email=f"g_{uuid.uuid4().hex[:8]}@t.io",
             name="갤러리", hashed_password="x")
    db.add(u)
    await db.flush()
    ev = Event(
        id=uuid.uuid4(), organizer_id=u.id, title="4일 대회",
        slug=f"g-{uuid.uuid4().hex[:8]}", venue="골프장",
        event_date=_at(2026, 8, 20, 7), event_date_end=_at(2026, 8, 23, 18),
        bidding_opens_at=_at(2026, 7, 20), bidding_closes_at=_at(2026, 8, 19),
        total_seats=100, status=EventStatus.APPROVED, admission_mode=admission_mode,
    )
    db.add(ev)
    await db.flush()
    tier = SeatTier(id=uuid.uuid4(), event_id=ev.id, name="주중권", capacity=100,
                    base_price=15000, sale_mode="fixed_fcfs", tier_metadata=tier_metadata)
    db.add(tier)
    await db.flush()
    t = Ticket(id=uuid.uuid4(), event_id=ev.id, tier_id=tier.id, current_owner_id=u.id,
               purchase_price=15000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
    db.add(t)
    await db.flush()
    return ev, tier, t


# ── ① single = 생애 1회 ──────────────────────────────────────────────────────
async def test_single_blocks_next_day_reentry(db_session):
    """실측 결함: 8/20 입장한 티켓이 8/21 에 또 admitted 됐다."""
    ev, _, t = await _mk(db_session)

    r1 = await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    assert r1.outcome == "admitted"

    with pytest.raises(AdmissionError) as exc:
        await admit(db_session, t, ev, _at(2026, 8, 21), run_side_effects=False)
    assert exc.value.code == "ALREADY_ADMITTED"


async def test_single_still_allows_same_day_reentry(db_session):
    """당일 재입장(점심·주차 반복출입)은 계속 정상이어야 한다 — 과잉 차단 방지."""
    ev, _, t = await _mk(db_session)

    await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    r2 = await admit(db_session, t, ev, _at(2026, 8, 20, 15), run_side_effects=False)
    assert r2.outcome == "reentry_ok" and r2.already is True


async def test_single_reentry_allowed_after_revoke(db_session):
    """입장 취소(오스캔 정정)하면 다시 입장할 수 있어야 한다 — 원장 기반이라 자연히 성립."""
    ev, _, t = await _mk(db_session)

    await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    await revoke_admission(db_session, t, ev, date(2026, 8, 20))

    r = await admit(db_session, t, ev, _at(2026, 8, 21), run_side_effects=False)
    assert r.outcome == "admitted"


# ── ② 등급별 입장 가능일 ─────────────────────────────────────────────────────
async def test_tier_admission_days_blocks_other_day(db_session):
    """주중권(목·금)으로 결승일(일) 입장 시도 → 거부."""
    ev, _, t = await _mk(
        db_session, admission_mode="daypass",
        tier_metadata={"admission_days": ["2026-08-20", "2026-08-21"]},
    )

    with pytest.raises(AdmissionError) as exc:
        await admit(db_session, t, ev, _at(2026, 8, 23), run_side_effects=False)
    assert exc.value.code == "NOT_ADMISSION_DAY"


async def test_tier_admission_days_allows_own_day_once(db_session):
    """주중권은 목·금 중 **하루만** — 목요일 입장 후 금요일은 daypass 가 막는다."""
    ev, _, t = await _mk(
        db_session, admission_mode="daypass",
        tier_metadata={"admission_days": ["2026-08-20", "2026-08-21"]},
    )

    r = await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    assert r.outcome == "admitted"
    assert t.admission_day is not None  # 첫 입장일로 확정

    with pytest.raises(AdmissionError) as exc:
        await admit(db_session, t, ev, _at(2026, 8, 21), run_side_effects=False)
    assert exc.value.code == "NOT_ADMISSION_DAY"


async def test_tier_admission_days_absent_keeps_old_behavior(db_session):
    """미설정이면 종전대로 — 이벤트 기간만 본다(기존 이벤트 회귀 방지)."""
    ev, _, t = await _mk(db_session, admission_mode="daypass", tier_metadata={"other": 1})

    r = await admit(db_session, t, ev, _at(2026, 8, 22), run_side_effects=False)
    assert r.outcome == "admitted"


async def test_tier_admission_days_malformed_is_loud(db_session):
    """설정이 깨졌으면 조용히 흘리지 않는다 — 전원거부도, 제한소멸도 둘 다 조용한 실패다."""
    ev, _, t = await _mk(
        db_session, admission_mode="daypass",
        tier_metadata={"admission_days": ["2026-08-20", "어제"]},
    )

    with pytest.raises(AdmissionError) as exc:
        await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    assert exc.value.code == "TIER_ADMISSION_DAYS_INVALID"


# ── F1 회귀: 등급 수정이 admission_days 를 지우면 안 된다 ────────────────────────
def test_merge_tier_metadata_preserves_unknown_keys():
    """🔴 실측 결함: 좌석등급을 한 번만 저장해도 등급별 입장일이 사라졌다.

    go 의 등급 수정 경로는 매번 `{go_source: ...}` 만 담은 **새 객체**를 보내는데
    v2 가 tier_metadata 를 전량 교체하고 있었다 ⟹ 운영이 심어둔 admission_days 소실
    ⟹ 15,000원 주중권으로 결승일 입장이 다시 열린다. 예외도 로그도 없다.
    """
    from app.api.v1.internal_commerce import _merge_tier_metadata

    current = {"go_source": "seat_tier", "admission_days": ["2026-08-20", "2026-08-21"]}

    # go 가 모르는 키는 보존된다 — 이게 핵심.
    merged = _merge_tier_metadata(current, {"go_source": "seat_tier"})
    assert merged["admission_days"] == ["2026-08-20", "2026-08-21"]
    assert merged["go_source"] == "seat_tier"

    # 보낸 키는 갱신된다.
    merged = _merge_tier_metadata(current, {"admission_days": ["2026-08-22"]})
    assert merged["admission_days"] == ["2026-08-22"]

    # 키 삭제는 그 키에 null 을 보내 명시한다.
    merged = _merge_tier_metadata(current, {"admission_days": None})
    assert "admission_days" not in merged
    assert merged["go_source"] == "seat_tier"

    # 딕셔너리 전체 null 은 전체 삭제(명시 의도) — 종전 계약 유지.
    assert _merge_tier_metadata(current, None) is None
