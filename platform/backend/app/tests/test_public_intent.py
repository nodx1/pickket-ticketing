"""공개 랜딩 부속기능(RSVP·단체예약·컨텍스트배너) — 상세통합 트랙B U3 테스트.

커버리지:
  - RSVP 공개 왕복: 게이트(rsvp_enabled) OFF→403, ON→confirmed 저장, 중복 이메일→409.
  - 단체예약 공개 왕복: 게이트(group_booking_enabled) OFF→403, ON→pending 저장 + 주최자 통지.
  - 비공개/미존재 이벤트 → 404(enumeration 방지).
  - go→v2 write-through: internal/events create·patch 로 rsvp_enabled 등 세팅 → EventResponse 노출.
"""
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.notification import NotificationModel
from app.models.organizer import OrganizerProfile
from app.models.public_intent import GroupBookingRequest, RsvpRegistration
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_event(
    db_session,
    *,
    rsvp_enabled: bool = False,
    group_booking_enabled: bool = False,
    status: EventStatus = EventStatus.BIDDING_OPEN,
) -> Event:
    user = User(
        email=f"org-{uuid.uuid4().hex[:8]}@test.com",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    now = datetime.now(timezone.utc)
    event = Event(
        organizer_id=user.id,
        title="테스트 이벤트",
        slug=f"evt-{uuid.uuid4().hex[:8]}",
        venue="올림픽홀",
        event_date=now,
        bidding_opens_at=now,
        bidding_closes_at=now.replace(year=now.year + 1),
        total_seats=100,
        category="concert",
        status=status,
        rsvp_enabled=rsvp_enabled,
        group_booking_enabled=group_booking_enabled,
    )
    db_session.add(event)
    await db_session.commit()
    return event


# ── RSVP ─────────────────────────────────────────────────────────────────


async def test_rsvp_gate_off_returns_403(client, db_session):
    event = await _seed_event(db_session, rsvp_enabled=False)
    r = await client.post(
        "/api/v1/public/rsvp",
        json={"event_id": str(event.id), "name": "홍길동", "email": "a@b.com"},
    )
    assert r.status_code == 403, r.text


async def test_rsvp_roundtrip_confirmed_and_persisted(client, db_session):
    event = await _seed_event(db_session, rsvp_enabled=True)
    r = await client.post(
        "/api/v1/public/rsvp",
        json={"event_id": str(event.id), "name": "홍길동", "email": "RSVP@B.com", "phone": "010-1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed"
    reg = (
        await db_session.execute(
            select(RsvpRegistration).where(RsvpRegistration.event_id == event.id)
        )
    ).scalar_one()
    assert reg.email == "rsvp@b.com"  # 정규화(소문자)
    assert reg.name == "홍길동"


async def test_rsvp_duplicate_email_returns_409(client, db_session):
    event = await _seed_event(db_session, rsvp_enabled=True)
    payload = {"event_id": str(event.id), "name": "홍길동", "email": "dup@b.com"}
    r1 = await client.post("/api/v1/public/rsvp", json=payload)
    assert r1.status_code == 200, r1.text
    r2 = await client.post("/api/v1/public/rsvp", json=payload)
    assert r2.status_code == 409, r2.text


async def test_rsvp_unknown_event_returns_404(client, db_session):
    r = await client.post(
        "/api/v1/public/rsvp",
        json={"event_id": str(uuid.uuid4()), "name": "홍길동", "email": "a@b.com"},
    )
    assert r.status_code == 404, r.text


async def test_rsvp_draft_event_returns_404(client, db_session):
    # 비공개(draft) 이벤트는 게이트가 켜져 있어도 제출 불가(404 위장).
    event = await _seed_event(db_session, rsvp_enabled=True, status=EventStatus.DRAFT)
    r = await client.post(
        "/api/v1/public/rsvp",
        json={"event_id": str(event.id), "name": "홍길동", "email": "a@b.com"},
    )
    assert r.status_code == 404, r.text


# ── 단체예약 ───────────────────────────────────────────────────────────────


async def test_group_booking_gate_off_returns_403(client, db_session):
    event = await _seed_event(db_session, group_booking_enabled=False)
    r = await client.post(
        "/api/v1/public/group-bookings",
        json={
            "event_id": str(event.id),
            "organization_name": "테스트단체",
            "contact_name": "김담당",
            "contact_email": "c@b.com",
            "attendee_count": 20,
        },
    )
    assert r.status_code == 403, r.text


async def test_group_booking_roundtrip_persist_and_notifies_organizer(client, db_session):
    event = await _seed_event(db_session, group_booking_enabled=True)
    r = await client.post(
        "/api/v1/public/group-bookings",
        json={
            "event_id": str(event.id),
            "organization_name": "테스트단체",
            "contact_name": "김담당",
            "contact_email": "Lead@B.com",
            "contact_phone": "010-2",
            "attendee_count": 30,
            "notes": "휠체어석 필요",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"

    booking = (
        await db_session.execute(
            select(GroupBookingRequest).where(GroupBookingRequest.event_id == event.id)
        )
    ).scalar_one()
    assert booking.attendee_count == 30
    assert booking.contact_email == "lead@b.com"

    # 주최자 통지 1건(NotificationModel, event.organizer_id 앞).
    notif = (
        await db_session.execute(
            select(NotificationModel).where(
                NotificationModel.event_id == event.id,
                NotificationModel.type == "group_booking_request",
            )
        )
    ).scalar_one()
    assert notif.user_id == event.organizer_id
    assert notif.data["booking_id"] == str(booking.id)


async def test_group_booking_accepts_consumer_aliases(client, db_session):
    # consumer 어휘(org_name/product_id) 로도 수신돼야 한다(프론트 계약 호환).
    event = await _seed_event(db_session, group_booking_enabled=True)
    tier_id = str(uuid.uuid4())
    r = await client.post(
        "/api/v1/public/group-bookings",
        json={
            "event_id": str(event.id),
            "org_name": "별칭단체",
            "contact_name": "김담당",
            "contact_email": "c@b.com",
            "attendee_count": 15,
            "product_id": tier_id,
        },
    )
    assert r.status_code == 200, r.text
    booking = (
        await db_session.execute(
            select(GroupBookingRequest).where(GroupBookingRequest.event_id == event.id)
        )
    ).scalar_one()
    assert booking.organization_name == "별칭단체"
    assert str(booking.tier_id) == tier_id


async def test_group_booking_min_attendee_validation(client, db_session):
    event = await _seed_event(db_session, group_booking_enabled=True)
    r = await client.post(
        "/api/v1/public/group-bookings",
        json={
            "event_id": str(event.id),
            "organization_name": "테스트단체",
            "contact_name": "김담당",
            "contact_email": "c@b.com",
            "attendee_count": 1,  # < 2 → 422
        },
    )
    assert r.status_code == 422, r.text


# ── go→v2 write-through (internal/events) → EventResponse 노출 ──────────────


async def _seed_organizer_profile(db_session, go_account_id="go_u3_org") -> User:
    user = User(
        email=f"{go_account_id}@org.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id,
            company_name="테스트 주최",
            contact_email="org@test.com",
            go_account_id=go_account_id,
        )
    )
    await db_session.commit()
    return user


def _event_body(**over) -> dict:
    body = {
        "organizer_ref": {"go_account_id": "go_u3_org"},
        "external_ref": f"go_evt_{uuid.uuid4().hex[:8]}",
        "title": "U3 이벤트",
        "venue": "올림픽홀",
        "category": "concert",
        "event_date": "2026-08-20T19:00:00+09:00",
        "sale_window": {
            "opens_at": "2026-07-01T10:00:00+09:00",
            "closes_at": "2026-07-10T23:59:59+09:00",
        },
        "status": "draft",
    }
    body.update(over)
    return body


async def test_write_through_create_sets_public_intent_gates(client, db_session):
    await _seed_organizer_profile(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(
            rsvp_enabled=True, group_booking_enabled=True, context_banner="오늘 마감!"
        ),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    event_id = uuid.UUID(r.json()["data"]["event_id"])
    event = await db_session.get(Event, event_id)
    assert event.rsvp_enabled is True
    assert event.group_booking_enabled is True
    assert event.context_banner == "오늘 마감!"


async def test_write_through_patch_toggles_gates_and_clears_banner(client, db_session):
    await _seed_organizer_profile(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(rsvp_enabled=True, context_banner="공지"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert created.status_code == 200, created.text
    event_id = created.json()["data"]["event_id"]

    # PATCH: rsvp OFF, group ON, 배너 해제(빈 문자열→NULL).
    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"rsvp_enabled": False, "group_booking_enabled": True, "context_banner": ""},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.rsvp_enabled is False
    assert event.group_booking_enabled is True
    assert event.context_banner is None


async def test_write_through_patch_omitted_field_preserves(client, db_session):
    await _seed_organizer_profile(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(rsvp_enabled=True, context_banner="유지"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    # context_banner 미포함 PATCH → 보존(model_fields_set).
    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"group_booking_enabled": True},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.context_banner == "유지"  # 보존됨
    assert event.rsvp_enabled is True  # 보존됨


# ── F8: status CHECK 무결성 (unify8_0723 · model __table_args__ 정합) ──────────


async def test_rsvp_status_check_rejects_invalid(client, db_session):
    """F8: rsvp_registrations.status CHECK — 허용 밖 값은 DB 가 거부(IntegrityError)."""
    from sqlalchemy.exc import IntegrityError

    event = await _seed_event(db_session, rsvp_enabled=True)
    db_session.add(
        RsvpRegistration(event_id=event.id, name="홍길동", email="x@b.com", status="bogus")
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_rsvp_status_check_allows_valid(client, db_session):
    """F8: rsvp_registrations.status 허용값(pending/confirmed/cancelled)은 통과."""
    event = await _seed_event(db_session, rsvp_enabled=True)
    for st in ("pending", "confirmed", "cancelled"):
        db_session.add(
            RsvpRegistration(
                event_id=event.id, name="홍", email=f"{st}@b.com", status=st
            )
        )
    await db_session.flush()  # 예외 없이 통과.


async def test_group_booking_status_check_rejects_invalid(client, db_session):
    """F8: group_booking_requests.status CHECK — 허용 밖 값은 DB 가 거부."""
    from sqlalchemy.exc import IntegrityError

    event = await _seed_event(db_session, group_booking_enabled=True)
    db_session.add(
        GroupBookingRequest(
            event_id=event.id,
            organization_name="단체",
            contact_name="김",
            contact_email="c@b.com",
            attendee_count=10,
            status="bogus",
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_group_booking_status_check_allows_valid(client, db_session):
    """F8: group_booking_requests.status 허용값(pending/contacted/closed)은 통과."""
    event = await _seed_event(db_session, group_booking_enabled=True)
    for i, st in enumerate(("pending", "contacted", "closed")):
        db_session.add(
            GroupBookingRequest(
                event_id=event.id,
                organization_name=f"단체{i}",
                contact_name="김",
                contact_email="c@b.com",
                attendee_count=10,
                status=st,
            )
        )
    await db_session.flush()  # 예외 없이 통과.
