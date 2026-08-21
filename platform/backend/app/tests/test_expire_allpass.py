"""F1 §3.2 후속 — allpass(전일권) 티켓 종료→USED/EXPIRED 전환 태스크 수용 테스트.

정책(확정: 미입장=EXPIRED): 종료 allpass ACTIVE 중 입장분(first_checked_in_at 有)
→USED / 미입장분(無)→EXPIRED. 미종료 allpass 불변 / single·daypass 불변 /
이미 USED·비-ACTIVE 무영향 / KST 종료경계 / 멱등(재실행 0건) / 배치(청크).

settlement_clawback 테스트와 동일한 sync SQLite + SyncSession monkeypatch 패턴.
celery 태스크는 SyncSession(동기 ORM) 을 쓰므로 async db_session 픽스처가 아닌
전용 동기 엔진을 구성한다.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403  (전체 매퍼 등록)
from app.models.event import Event, EventStatus, SeatTier
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.tasks.expire_allpass import expire_allpass_tickets


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):  # noqa: ARG001
    return "CHAR(32)"


sync_engine = create_engine("sqlite://", echo=False)
TestSyncSession = sessionmaker(sync_engine)

# KST 벽시계 → UTC 저장 헬퍼. 이벤트 종료시각(event_date_end)은 KST 벽시계로 지정된 뒤
# timestamptz(UTC)로 저장된다 — 태스크의 인스턴트 종료판정이 KST 기준과 일치함을 검증.
KST = timezone(timedelta(hours=9))


def _kst(y, m, d, hh=18, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=KST).astimezone(timezone.utc)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.expire_allpass.SyncSession", TestSyncSession)
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


def _mk_user(session) -> User:
    u = User(email=f"u_{uuid.uuid4().hex[:8]}@test.io", hashed_password="x", name="u")
    session.add(u)
    session.flush()
    return u


def _mk_event(session, *, admission_mode, start, end=None) -> Event:
    ev = Event(
        organizer_id=_mk_user(session).id,
        title="allpass 이벤트",
        slug=f"ap-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=start,
        event_date_end=end,
        bidding_opens_at=start - timedelta(days=30),
        bidding_closes_at=start - timedelta(days=1),
        total_seats=100,
        status=EventStatus.APPROVED,
        admission_mode=admission_mode,
    )
    session.add(ev)
    session.flush()
    return ev


def _mk_ticket(
    session, event, owner, *, status=TicketStatus.ACTIVE, checked_in=False
) -> Ticket:
    tier = SeatTier(
        event_id=event.id, name="GA", capacity=100, base_price=1000, sale_mode="fixed_fcfs"
    )
    session.add(tier)
    session.flush()
    t = Ticket(
        event_id=event.id,
        tier_id=tier.id,
        current_owner_id=owner.id,
        purchase_price=1000,
        sale_mode="fixed_fcfs",
        status=status,
        # 입장이력: checked_in=True 면 최초입장 시각 기록(정책상 USED 대상).
        first_checked_in_at=(
            datetime.now(timezone.utc) - timedelta(days=3) if checked_in else None
        ),
    )
    session.add(t)
    session.flush()
    return t


def _status(session, ticket_id) -> TicketStatus:
    return session.execute(
        select(Ticket.status).where(Ticket.id == ticket_id)
    ).scalar_one()


# ── 핵심: 종료 allpass 입장분→USED / 미입장분→EXPIRED ─────────────────────────
def test_ended_allpass_split_by_checkin():
    with TestSyncSession() as s:
        u = _mk_user(s)
        # 3일권, 마지막날이 이미 과거 → 종료.
        start = datetime.now(timezone.utc) - timedelta(days=5)
        ev = _mk_event(
            s, admission_mode="allpass",
            start=start, end=start + timedelta(days=2),
        )
        entered = _mk_ticket(s, ev, u, checked_in=True)   # 입장 → USED
        never = _mk_ticket(s, ev, u, checked_in=False)    # 미입장 → EXPIRED
        eid, nid = entered.id, never.id
        s.commit()

    # 이벤트가 과거 종료라 현재시각 기준으로 종료 판정됨.
    res = expire_allpass_tickets.run(chunk_size=1000)
    assert res["used"] == 1
    assert res["expired"] == 1
    assert res["total"] == 2

    with TestSyncSession() as s:
        assert _status(s, eid) == TicketStatus.USED
        assert _status(s, nid) == TicketStatus.EXPIRED

    # 멱등: 재실행 0건, 상태 불변.
    rerun = expire_allpass_tickets.run()
    assert rerun["used"] == 0
    assert rerun["expired"] == 0
    assert rerun["total"] == 0
    with TestSyncSession() as s:
        assert _status(s, eid) == TicketStatus.USED
        assert _status(s, nid) == TicketStatus.EXPIRED


# ── 미종료 allpass 불변 ───────────────────────────────────────────────────────
def test_ongoing_allpass_unchanged():
    with TestSyncSession() as s:
        u = _mk_user(s)
        # 미래 이벤트(내년) — 아직 종료 안 됨.
        future = datetime.now(timezone.utc) + timedelta(days=365)
        ev = _mk_event(
            s, admission_mode="allpass",
            start=future, end=future + timedelta(days=2),
        )
        t = _mk_ticket(s, ev, u)
        tid = t.id
        s.commit()

    res = expire_allpass_tickets.run()
    assert res["total"] == 0
    with TestSyncSession() as s:
        assert _status(s, tid) == TicketStatus.ACTIVE


# ── single / daypass 불변(비-allpass) ─────────────────────────────────────────
def test_single_and_daypass_unaffected_even_when_ended():
    with TestSyncSession() as s:
        u = _mk_user(s)
        past = datetime.now(timezone.utc) - timedelta(days=10)
        single_ev = _mk_event(s, admission_mode="single", start=past)
        daypass_ev = _mk_event(
            s, admission_mode="daypass", start=past, end=past + timedelta(days=2)
        )
        single_t = _mk_ticket(s, single_ev, u)
        daypass_t = _mk_ticket(s, daypass_ev, u)
        sid, did = single_t.id, daypass_t.id
        s.commit()

    res = expire_allpass_tickets.run()
    assert res["total"] == 0
    with TestSyncSession() as s:
        assert _status(s, sid) == TicketStatus.ACTIVE
        assert _status(s, did) == TicketStatus.ACTIVE


# ── 이미 USED / 비-ACTIVE 무영향 ──────────────────────────────────────────────
def test_non_active_statuses_untouched():
    with TestSyncSession() as s:
        u = _mk_user(s)
        past = datetime.now(timezone.utc) - timedelta(days=10)
        ev = _mk_event(
            s, admission_mode="allpass", start=past, end=past + timedelta(days=2)
        )
        used_t = _mk_ticket(s, ev, u, status=TicketStatus.USED)
        cancelled_t = _mk_ticket(s, ev, u, status=TicketStatus.CANCELLED)
        pending_t = _mk_ticket(s, ev, u, status=TicketStatus.PENDING)
        uid, cid, pid = used_t.id, cancelled_t.id, pending_t.id
        s.commit()

    res = expire_allpass_tickets.run()
    assert res["total"] == 0  # 전환 대상은 ACTIVE 뿐
    with TestSyncSession() as s:
        assert _status(s, uid) == TicketStatus.USED
        assert _status(s, cid) == TicketStatus.CANCELLED
        assert _status(s, pid) == TicketStatus.PENDING


# ── event_date_end 없는 allpass: event_date 로 종료판정 ───────────────────────
def test_allpass_without_end_uses_event_date():
    with TestSyncSession() as s:
        u = _mk_user(s)
        past = datetime.now(timezone.utc) - timedelta(days=1)
        # event_date_end=None → coalesce 로 event_date 사용, 이미 지남 → 종료.
        ev = _mk_event(s, admission_mode="allpass", start=past, end=None)
        entered = _mk_ticket(s, ev, u, checked_in=True)   # → USED
        never = _mk_ticket(s, ev, u, checked_in=False)    # → EXPIRED
        eid, nid = entered.id, never.id
        s.commit()

    res = expire_allpass_tickets.run()
    assert res["used"] == 1
    assert res["expired"] == 1
    with TestSyncSession() as s:
        assert _status(s, eid) == TicketStatus.USED
        assert _status(s, nid) == TicketStatus.EXPIRED


# ── KST 종료경계: end_date 인스턴트 직전/직후 ─────────────────────────────────
def test_kst_end_boundary(monkeypatch):
    """종료시각 인스턴트 전에는 불변, 후에는 전환. 인스턴트 비교의 정확성 검증."""
    end_instant = _kst(2026, 8, 23, 18, 0)  # 2026-08-23 18:00 KST 종료
    with TestSyncSession() as s:
        u = _mk_user(s)
        ev = _mk_event(
            s, admission_mode="allpass",
            start=_kst(2026, 8, 21), end=end_instant,
        )
        entered = _mk_ticket(s, ev, u, checked_in=True)   # → USED (종료 후)
        never = _mk_ticket(s, ev, u, checked_in=False)    # → EXPIRED (종료 후)
        eid, nid = entered.id, never.id
        s.commit()

    import app.tasks.expire_allpass as mod

    class _FixedDateTime(datetime):
        _now = end_instant - timedelta(seconds=1)  # 종료 1초 전

        @classmethod
        def now(cls, tz=None):
            return cls._now if tz is None else cls._now.astimezone(tz)

    # 종료 1초 전 → 아직 진행중, 불변.
    monkeypatch.setattr(mod, "datetime", _FixedDateTime)
    res_before = expire_allpass_tickets.run()
    assert res_before["total"] == 0
    with TestSyncSession() as s:
        assert _status(s, eid) == TicketStatus.ACTIVE
        assert _status(s, nid) == TicketStatus.ACTIVE

    # 종료 1초 후 → 종료 확정. 입장분 USED, 미입장분 EXPIRED.
    _FixedDateTime._now = end_instant + timedelta(seconds=1)
    res_after = expire_allpass_tickets.run()
    assert res_after["used"] == 1
    assert res_after["expired"] == 1
    with TestSyncSession() as s:
        assert _status(s, eid) == TicketStatus.USED
        assert _status(s, nid) == TicketStatus.EXPIRED


# ── 배치(청크): chunk_size 보다 많은 티켓도 전부 전환(양쪽 분기 각각 청킹) ─────
def test_batch_chunking_expires_all():
    with TestSyncSession() as s:
        u = _mk_user(s)
        past = datetime.now(timezone.utc) - timedelta(days=5)
        ev = _mk_event(
            s, admission_mode="allpass", start=past, end=past + timedelta(days=1)
        )
        used_ids = [_mk_ticket(s, ev, u, checked_in=True).id for _ in range(7)]   # → USED
        exp_ids = [_mk_ticket(s, ev, u, checked_in=False).id for _ in range(5)]   # → EXPIRED
        s.commit()

    # chunk_size=3 → USED 7건(3+3+1)·EXPIRED 5건(3+2) 두 분기 각각 청킹해 전부 전환.
    res = expire_allpass_tickets.run(chunk_size=3)
    assert res["used"] == 7
    assert res["expired"] == 5
    assert res["total"] == 12
    with TestSyncSession() as s:
        for tid in used_ids:
            assert _status(s, tid) == TicketStatus.USED
        for tid in exp_ids:
            assert _status(s, tid) == TicketStatus.EXPIRED
