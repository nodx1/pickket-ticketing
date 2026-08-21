"""F1 다일 입장 — admit() 서비스 수용 테스트 (CHECKIN-STATE-CONTRACT-F1 §5).

single 회귀 / daypass 지정·선택 / allpass day1·재스캔·day2·기간외 / 동시 2게이트 /
부작용 최초1회 / KST 경계 / transfer·resale 가드.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.event_admission import EventAdmission
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.admission_service import (
    AdmissionError,
    admit,
    revoke_admission,
)
from app.tests.conftest import TestSession

KST = timezone(timedelta(hours=9))


async def _mk_user(db) -> User:
    u = User(
        id=uuid.uuid4(),
        email=f"u_{uuid.uuid4().hex[:8]}@test.io",
        name="입장객",
        hashed_password="x",
    )
    db.add(u)
    await db.flush()
    return u


async def _mk_event(db, *, admission_mode="single", start, end=None, nft=False) -> Event:
    ev = Event(
        id=uuid.uuid4(),
        organizer_id=(await _mk_user(db)).id,
        title="F1 이벤트",
        slug=f"f1-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=start,
        event_date_end=end,
        bidding_opens_at=start - timedelta(days=30),
        bidding_closes_at=start - timedelta(days=1),
        total_seats=100,
        status=EventStatus.APPROVED,
        admission_mode=admission_mode,
        nft_enabled=nft,
    )
    db.add(ev)
    await db.flush()
    return ev


async def _mk_ticket(db, event, owner, *, status=TicketStatus.ACTIVE, admission_day=None) -> Ticket:
    from app.models.event import SeatTier

    tier = SeatTier(
        id=uuid.uuid4(), event_id=event.id, name="GA", capacity=100,
        base_price=1000, sale_mode="fixed_fcfs",
    )
    db.add(tier)
    await db.flush()
    t = Ticket(
        id=uuid.uuid4(), event_id=event.id, tier_id=tier.id, current_owner_id=owner.id,
        purchase_price=1000, sale_mode="fixed_fcfs", status=status, admission_day=admission_day,
    )
    db.add(t)
    await db.flush()
    return t


def _at(y, m, d, hh=10, mm=0) -> datetime:
    """KST wall-clock 시각 → UTC aware datetime (admit 은 내부에서 KST 변환)."""
    return datetime(y, m, d, hh, mm, tzinfo=KST).astimezone(timezone.utc)


# ── single 회귀 ─────────────────────────────────────────────────────────────
async def test_single_admit_then_rescan_already(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="single", start=_at(2026, 8, 20))
    t = await _mk_ticket(db_session, ev, u)

    r1 = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    assert r1.already is False and r1.first_admission is True
    assert t.status == TicketStatus.USED

    r2 = await admit(db_session, t, ev, _at(2026, 8, 20, 11), run_side_effects=False)
    assert r2.already is True and r2.first_admission is False
    # 원장 1행만.
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 1


async def test_single_rejects_cancelled(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="single", start=_at(2026, 8, 20))
    t = await _mk_ticket(db_session, ev, u, status=TicketStatus.CANCELLED)
    with pytest.raises(AdmissionError) as e:
        await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    assert e.value.code == "NOT_ADMITTABLE"


# ── daypass 지정 ────────────────────────────────────────────────────────────
async def test_daypass_assigned_day_ok_other_day_rejected(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="daypass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    from datetime import date
    t = await _mk_ticket(db_session, ev, u, admission_day=date(2026, 8, 21))

    # 지정일 아님(20일) → 거부.
    with pytest.raises(AdmissionError) as e:
        await admit(db_session, t, ev, _at(2026, 8, 20), run_side_effects=False)
    assert e.value.code == "NOT_ADMISSION_DAY"

    # 지정일(21일) → OK.
    r = await admit(db_session, t, ev, _at(2026, 8, 21), run_side_effects=False)
    assert r.already is False
    assert t.status == TicketStatus.USED
    # 재스캔 → already.
    r2 = await admit(db_session, t, ev, _at(2026, 8, 21, 15), run_side_effects=False)
    assert r2.already is True


# ── daypass 선택형(미확정) — 첫 입장일로 확정 ───────────────────────────────
async def test_daypass_open_confirms_first_day(db_session):
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="daypass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u, admission_day=None)

    r = await admit(db_session, t, ev, _at(2026, 8, 22), run_side_effects=False)
    assert r.already is False
    assert t.admission_day == date(2026, 8, 22)  # 첫 입장일로 확정

    # 이후 다른 날 거부.
    with pytest.raises(AdmissionError):
        await admit(db_session, t, ev, _at(2026, 8, 23), run_side_effects=False)


# ── allpass (핵심) ──────────────────────────────────────────────────────────
async def test_allpass_multi_day(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    # day1 OK, ACTIVE 유지.
    r1 = await admit(db_session, t, ev, _at(2026, 8, 20, 8), run_side_effects=False)
    assert r1.already is False
    assert t.status == TicketStatus.ACTIVE  # allpass 는 소진 안 함

    # day1 재스캔 → already.
    r1b = await admit(db_session, t, ev, _at(2026, 8, 20, 12), run_side_effects=False)
    assert r1b.already is True

    # day2 OK (거부 안 됨 ← 핵심).
    r2 = await admit(db_session, t, ev, _at(2026, 8, 21, 8), run_side_effects=False)
    assert r2.already is False
    assert t.status == TicketStatus.ACTIVE

    # 원장 = 2행(day1, day2).
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 2

    # 기간 외(19일·24일) 거부.
    with pytest.raises(AdmissionError):
        await admit(db_session, t, ev, _at(2026, 8, 19), run_side_effects=False)
    with pytest.raises(AdmissionError):
        await admit(db_session, t, ev, _at(2026, 8, 24), run_side_effects=False)


# ── 동시 2게이트 (같은 티켓·같은 날 → 1건만, 패자 already) ──────────────────
async def test_concurrent_two_gates_one_wins(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)
    await db_session.commit()

    async with TestSession() as s1, TestSession() as s2:
        t1 = await s1.get(Ticket, t.id)
        e1 = await s1.get(Event, ev.id)
        t2 = await s2.get(Ticket, t.id)
        e2 = await s2.get(Event, ev.id)

        r1 = await admit(s1, t1, e1, _at(2026, 8, 20, 9), run_side_effects=False)
        await s1.commit()
        # s2 는 같은 날 원장이 이미 커밋됨을 만나 already 처리(4번 조회 or IntegrityError 경로).
        r2 = await admit(s2, t2, e2, _at(2026, 8, 20, 9), run_side_effects=False)
        await s2.commit()

    assert (r1.already, r2.already) in [(False, True)]
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(
            EventAdmission.ticket_id == t.id,
        )
    )).scalar()
    assert cnt == 1


# ── IntegrityError 패자 경로(원장 존재검사 통과했으나 INSERT 충돌) → already ──
async def test_admit_integrity_error_falls_back_to_already(db_session, monkeypatch):
    """동시 게이트가 존재검사와 INSERT 사이에 원장을 만든 상황을 재현.

    admit 의 4번(존재검사)이 None 을 봤지만, 5번 INSERT 직전에 다른 게이트가 같은
    (ticket_id, today) 원장을 커밋 → UNIQUE 충돌 IntegrityError → admit 은 already 로 회복.
    """
    from datetime import date
    import app.services.admission_service as adm_mod

    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)
    await db_session.commit()

    today = date(2026, 8, 20)
    # 별도 세션(=다른 게이트)이 존재검사 직후 원장을 선점하도록 훅.
    inserted = {"done": False}
    orig_flush = db_session.flush

    async def racing_flush(*args, **kwargs):
        if not inserted["done"]:
            inserted["done"] = True
            async with TestSession() as other:
                other.add(EventAdmission(
                    ticket_id=t.id, event_id=ev.id, attended_date=today,
                    checked_in_at=datetime.now(timezone.utc), method="qr_scan",
                ))
                await other.commit()
        return await orig_flush(*args, **kwargs)

    monkeypatch.setattr(db_session, "flush", racing_flush)
    r = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    assert r.already is True  # 패자 → already

    monkeypatch.undo()
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 1


# ── 부작용 최초 1회 (allpass 3일 = 1회) ─────────────────────────────────────
async def test_side_effects_once_across_days(db_session):
    from app.models.point import PointType, PointTransactionType
    from app.models.point import PointTransaction
    from app.services.point_service import PointService

    u = await _mk_user(db_session)
    await PointService(db_session).create_wallets(u.id)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    for day in (20, 21, 22):
        await admit(db_session, t, ev, _at(2026, 8, day, 9), run_side_effects=True)
    await db_session.flush()

    # 체크인 적립 트랜잭션은 티켓 최초 입장 1회만(FAN+SOCIAL = 2건, 3일치 아님).
    checkin_txns = (await db_session.execute(
        select(func.count(PointTransaction.id)).where(
            PointTransaction.user_id == u.id,
            PointTransaction.tx_type == PointTransactionType.EARN_CHECKIN,
        )
    )).scalar()
    assert checkin_txns == 2  # FAN 1 + SOCIAL 1 (일자 무관 1회)
    assert t.first_checked_in_at is not None


# ── KST 경계: 06:00 KST(=21:00 UTC 전일) 입장이 당일로 기록 ───────────────
async def test_kst_boundary_records_local_date(db_session):
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    # 2026-08-20 21:00 UTC == 2026-08-21 06:00 KST → attended_date 는 KST 21일.
    utc_moment = datetime(2026, 8, 20, 21, 0, tzinfo=timezone.utc)
    r = await admit(db_session, t, ev, utc_moment, run_side_effects=False)
    assert r.attended_date == date(2026, 8, 21)
    adm = (await db_session.execute(
        select(EventAdmission).where(EventAdmission.ticket_id == t.id)
    )).scalar_one()
    assert adm.attended_date == date(2026, 8, 21)


# ── transfer 가드: 입장 후 양도 차단 ────────────────────────────────────────
async def test_transfer_blocked_after_admission(db_session):
    from app.services.transfer_service import TransferService

    u = await _mk_user(db_session)
    to = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    await db_session.flush()
    assert t.first_checked_in_at is not None
    assert t.status == TicketStatus.ACTIVE  # allpass — status 로는 못 막음

    with pytest.raises(ValueError, match="입장"):
        await TransferService(db_session).initiate_transfer(
            ticket_id=t.id, from_user_id=u.id, to_user_id=to.id,
        )


# ── F2 대량 초대: 발권 시 admission_day 지정 (OrderItemIn 스키마 + 티켓 부여 계약) ──
def test_order_item_in_accepts_admission_day():
    """F2 daypass 지정일 초대권 — 주문 라인이 admission_day 를 수용해야 한다.

    go bulkIssueInvitations 가 수신자별 지정일을 items[].admission_day 로 전달하고,
    internal_commerce.create_order 의 티켓 생성 루프가 이 값을 ticket.admission_day 로 부여한다.
    하위호환: 미전달 시 None(기존 동작 불변).
    """
    from datetime import date as _date

    from app.api.v1.internal_commerce import OrderItemIn

    # 지정일 있음 — date 로 파싱.
    with_day = OrderItemIn(external_ref="go_prod_1", quantity=1, unit_price=0, admission_day="2026-08-21")
    assert with_day.admission_day == _date(2026, 8, 21)

    # 미지정 — None(allpass/single/선택형 daypass).
    without_day = OrderItemIn(external_ref="go_prod_1", quantity=1, unit_price=0)
    assert without_day.admission_day is None


# ── §13 당일 재입장 outcome (admitted | reentry_ok) ─────────────────────────
async def test_outcome_admitted_then_reentry_ok(db_session):
    """당일 재스캔은 차단이 아니라 재입장 허용(reentry_ok, 초록). 최초는 admitted."""
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    r1 = await admit(db_session, t, ev, _at(2026, 8, 20, 8), run_side_effects=False)
    assert r1.outcome == "admitted"

    # 당일 재스캔(점심·주차) → reentry_ok (already=True 이지만 차단 아님).
    r2 = await admit(db_session, t, ev, _at(2026, 8, 20, 13), run_side_effects=False)
    assert r2.already is True
    assert r2.outcome == "reentry_ok"


async def test_outcome_single_consumed_other_day_rejected(db_session):
    """single/daypass 소진 후 '잘못된 날' 스캔은 AdmissionError(=rejected, 빨강)로 나간다."""
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="daypass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u, admission_day=date(2026, 8, 21))

    # 지정일 입장(admitted).
    r = await admit(db_session, t, ev, _at(2026, 8, 21), run_side_effects=False)
    assert r.outcome == "admitted"

    # 다른 날(22일) 스캔 → 차단(rejected). outcome 은 예외 경로라 호출측이 rejected 로 매핑.
    with pytest.raises(AdmissionError) as e:
        await admit(db_session, t, ev, _at(2026, 8, 22), run_side_effects=False)
    assert e.value.code == "NOT_ADMISSION_DAY"


# ── §13 체크인 undo/취소 (revoke_admission) ─────────────────────────────────
async def test_revoke_last_admission_reverts_status_and_allows_reentry(db_session):
    """유일 입장 취소 → status USED→ACTIVE·first_checked_in_at 리셋 → 재입장 가능."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="single", start=_at(2026, 8, 20))
    t = await _mk_ticket(db_session, ev, u)

    r = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    assert t.status == TicketStatus.USED
    assert t.first_checked_in_at is not None
    day = r.attended_date

    rev = await revoke_admission(db_session, t, ev, day)
    assert rev.revoked is True
    assert rev.was_last_admission is True
    assert rev.status_reverted is True
    assert rev.first_checked_in_reset is True
    assert t.status == TicketStatus.ACTIVE
    assert t.first_checked_in_at is None

    # 원장 0행.
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 0

    # 취소 후 재입장 가능(오스캔 복구).
    r2 = await admit(db_session, t, ev, _at(2026, 8, 20, 10), run_side_effects=False)
    assert r2.already is False
    assert r2.outcome == "admitted"
    assert t.status == TicketStatus.USED


async def test_revoke_idempotent_when_no_admission(db_session):
    """없는 입장 취소는 멱등 no-op (revoked=False), status 불변."""
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="single", start=_at(2026, 8, 20))
    t = await _mk_ticket(db_session, ev, u)

    rev = await revoke_admission(db_session, t, ev, date(2026, 8, 20))
    assert rev.revoked is False
    assert rev.was_last_admission is False
    assert t.status == TicketStatus.ACTIVE


async def test_revoke_one_day_of_allpass_keeps_status_and_first(db_session):
    """allpass 2일 입장 중 1일만 취소 → 남은 입장 있으므로 status/first 불변(부작용 안 되돌림)."""
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)

    r1 = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    await admit(db_session, t, ev, _at(2026, 8, 21, 9), run_side_effects=False)
    first_ts = t.first_checked_in_at
    assert first_ts is not None

    # day1 오스캔 취소 — day2 입장이 남아있음.
    rev = await revoke_admission(db_session, t, ev, r1.attended_date)
    assert rev.revoked is True
    assert rev.was_last_admission is False
    assert rev.status_reverted is False
    assert rev.first_checked_in_reset is False
    assert t.first_checked_in_at == first_ts  # 부작용 게이트 불변
    assert t.status == TicketStatus.ACTIVE

    # 원장 1행(day2) 남음.
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 1


async def test_revoke_daypass_open_choice_resets_admission_day(db_session):
    """선택형 daypass 오스캔 확정을 취소 → admission_day 리셋 → 올바른 날 재확정 가능."""
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="daypass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u, admission_day=None)

    # 잘못된 게이트가 20일로 확정.
    r = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    assert t.admission_day == date(2026, 8, 20)

    # 취소 → admission_day 리셋.
    rev = await revoke_admission(db_session, t, ev, r.attended_date)
    assert rev.revoked is True
    assert t.admission_day is None

    # 이제 올바른 날(22일)로 재확정 가능.
    r2 = await admit(db_session, t, ev, _at(2026, 8, 22, 9), run_side_effects=False)
    assert r2.already is False
    assert t.admission_day == date(2026, 8, 22)


async def test_revoke_concurrent_double_only_one_effective(db_session):
    """동시 2회 취소 — 커밋 순서상 한쪽만 revoked=True, 다른쪽 no-op(멱등)."""
    u = await _mk_user(db_session)
    ev = await _mk_event(
        db_session, admission_mode="allpass",
        start=_at(2026, 8, 20), end=_at(2026, 8, 23),
    )
    t = await _mk_ticket(db_session, ev, u)
    r = await admit(db_session, t, ev, _at(2026, 8, 20, 9), run_side_effects=False)
    day = r.attended_date
    await db_session.commit()

    async with TestSession() as s1, TestSession() as s2:
        t1 = await s1.get(Ticket, t.id)
        e1 = await s1.get(Event, ev.id)
        rev1 = await revoke_admission(s1, t1, e1, day)
        await s1.commit()
        t2 = await s2.get(Ticket, t.id)
        e2 = await s2.get(Event, ev.id)
        rev2 = await revoke_admission(s2, t2, e2, day)
        await s2.commit()

    assert (rev1.revoked, rev2.revoked) == (True, False)
    cnt = (await db_session.execute(
        select(func.count(EventAdmission.id)).where(EventAdmission.ticket_id == t.id)
    )).scalar()
    assert cnt == 0


# ═══════════════════════════════════════════════════════════════════
# 🔴 거부 사유 코드가 **응답에 실려 나가는가** (2026-08-10)
#
# `AdmissionError.code` 를 갖고 있으면서 응답에서 STATE_TRANSITION_FORBIDDEN 하나로
# 뭉쳐 보내면, go 가 **한국어 문구를 파싱해** 사유를 가른다 — 문구를 고치는 순간
# 조용히 오분류된다. 게이트에서 정상 티켓 손님이 "취소된 표" 라고 안내받는다.
#
# ⚠️ code·http(422)는 **그대로**여야 한다. 기존 계약을 깨면 안 된다.
# ═══════════════════════════════════════════════════════════════════


async def _checkin(client, ticket_id):
    return await client.post(
        f"/api/v1/internal/tickets/{ticket_id}/check-in",
        json={},
        headers={
            "x-pickket-service-token": settings.internal_service_token,
            "Idempotency-Key": str(uuid.uuid4()),
        },
    )


async def test_checkin_reject_carries_admission_code(client, db_session):
    """🔴 취소 티켓 → details.admission_code = NOT_ADMITTABLE."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="single", start=_at(2026, 8, 20))
    t = await _mk_ticket(db_session, ev, u, status=TicketStatus.CANCELLED)

    r = await _checkin(client, t.id)
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    # 기존 계약 — 바뀌면 안 된다
    assert err["code"] == "STATE_TRANSITION_FORBIDDEN"
    # 🔴 새로 실리는 것
    assert err["details"]["admission_code"] == "NOT_ADMITTABLE", (
        "🔴 코드가 소실되면 go 가 문구를 파싱해 사유를 가른다"
    )


async def test_checkin_reject_admission_day_code(client, db_session):
    """🔴 입장일 아님 → NOT_ADMISSION_DAY (취소와 **다른 코드**)."""
    from datetime import date

    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, admission_mode="daypass",
                         start=_at(2026, 8, 20), end=_at(2026, 8, 23))
    t = await _mk_ticket(db_session, ev, u, admission_day=date(2026, 8, 21))

    r = await _checkin(client, t.id)
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "STATE_TRANSITION_FORBIDDEN"
    assert err["details"]["admission_code"] == "NOT_ADMISSION_DAY"
    # 🔴 두 사유가 같은 값이면 가르는 의미가 없다
    assert err["details"]["admission_code"] != "NOT_ADMITTABLE"
