from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.audit_log import AuditLog
from app.models.event import Event, EventStatus, SeatTier
from app.models.notification import NotificationModel
from app.models.order import Order, OrderStatus, OrderType
from app.models.seat import Seat, SeatStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.models.waitlist import WaitlistEntryModel, WaitlistStatus
from app.tasks.payment_expiry import EXPIRY_GRACE_SECONDS, check_payment_expiry


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_engine = create_engine("sqlite://", echo=False)
TestSyncSession = sessionmaker(sync_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.payment_expiry.SyncSession", TestSyncSession)
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


def _seed_expired_order(
    *,
    order_quantity: int,
    tier_sold_count: int,
    waiters: list[dict],
    with_assigned_seats: bool = False,
):
    now = datetime.now(timezone.utc)
    with TestSyncSession() as session:
        organizer = User(
            email="realloc_org@test.com",
            hashed_password="x",
            name="Org",
            is_organizer=True,
        )
        buyer = User(
            email="realloc_buyer@test.com",
            hashed_password="x",
            name="Buyer",
        )
        session.add_all([organizer, buyer])
        session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Expiry Event",
            slug="test-payment-expiry-realloc",
            venue="Test Hall",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        session.add(event)
        session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="VIP",
            capacity=100,
            base_price=50.0,
            face_price=50.0,
            sale_mode="fixed_fcfs",
            sold_count=tier_sold_count,
        )
        session.add(tier)
        session.flush()

        expired_order = Order(
            user_id=buyer.id,
            event_id=event.id,
            tier_id=tier.id,
            order_type=OrderType.PURCHASE,
            status=OrderStatus.PAYMENT_REQUIRED,
            quantity=order_quantity,
            unit_price=50.0,
            total_amount=50.0 * order_quantity,
            # 만료 grace(EXPIRY_GRACE_SECONDS = 웹훅 확정 grace + 60s)를 확실히 지난 시점
            payment_deadline=now - timedelta(seconds=EXPIRY_GRACE_SECONDS + 300),
            payment_id="pay_expired_order",
            pg_provider="portone",
        )
        session.add(expired_order)
        session.flush()

        seat_ids = []
        if with_assigned_seats:
            for idx in range(order_quantity):
                seat = Seat(
                    event_id=event.id,
                    tier_id=tier.id,
                    section="A",
                    row_number=1,
                    seat_number=idx + 1,
                    status=SeatStatus.SOLD,
                )
                session.add(seat)
                session.flush()
                seat_ids.append(seat.id)

        for idx in range(order_quantity):
            session.add(
                Ticket(
                    event_id=event.id,
                    tier_id=tier.id,
                    seat_id=seat_ids[idx] if with_assigned_seats else None,
                    original_owner_id=buyer.id,
                    current_owner_id=buyer.id,
                    purchase_price=50.0,
                    sale_mode="fixed_fcfs",
                    purchase_order_id=expired_order.id,
                    status=TicketStatus.PENDING,
                )
            )

        waiter_ids = []
        for idx, waiter in enumerate(waiters):
            waiter_user = User(
                email=f"realloc_waiter_{idx}@test.com",
                hashed_password="x",
                name=f"Waiter {idx}",
            )
            session.add(waiter_user)
            session.flush()
            waiter_ids.append(waiter_user.id)
            session.add(
                WaitlistEntryModel(
                    event_id=event.id,
                    tier_id=tier.id,
                    user_id=waiter_user.id,
                    quantity=waiter["quantity"],
                    status=waiter["status"],
                    entered_at=now - timedelta(minutes=waiter.get("entered_minutes_ago", 1)),
                )
            )

        session.commit()
        return {
            "event_id": event.id,
            "tier_id": tier.id,
            "expired_order_id": expired_order.id,
            "waiter_ids": waiter_ids,
            "seat_ids": seat_ids,
        }


def test_realloc_to_waitlist_user():
    data = _seed_expired_order(
        order_quantity=2,
        tier_sold_count=2,
        waiters=[{"quantity": 1, "status": WaitlistStatus.WAITING}],
    )

    result = check_payment_expiry.run()
    assert result["expired_orders"] == 1
    assert result["reallocated"] == 1

    with TestSyncSession() as session:
        expired_order = session.execute(
            select(Order).where(Order.id == data["expired_order_id"])
        ).scalar_one()
        assert expired_order.status == OrderStatus.EXPIRED

        waiter_order = session.execute(
            select(Order).where(
                Order.user_id == data["waiter_ids"][0],
                Order.status == OrderStatus.PAYMENT_REQUIRED,
            )
        ).scalar_one_or_none()
        assert waiter_order is not None
        assert waiter_order.quantity == 1

        pending_tickets = (
            session.execute(select(Ticket).where(Ticket.purchase_order_id == waiter_order.id))
            .scalars()
            .all()
        )
        assert len(pending_tickets) == 1
        assert pending_tickets[0].status == TicketStatus.PENDING

        tier = session.execute(select(SeatTier).where(SeatTier.id == data["tier_id"])).scalar_one()
        assert tier.sold_count == 1


def test_no_waitlist_no_realloc():
    data = _seed_expired_order(order_quantity=1, tier_sold_count=1, waiters=[])

    result = check_payment_expiry.run()
    assert result["expired_orders"] == 1
    assert result["reallocated"] == 0
    assert result["released_seats"] == 1

    with TestSyncSession() as session:
        tier = session.execute(select(SeatTier).where(SeatTier.id == data["tier_id"])).scalar_one()
        assert tier.sold_count == 0


def test_partial_realloc():
    data = _seed_expired_order(
        order_quantity=2,
        tier_sold_count=2,
        waiters=[
            {"quantity": 1, "status": WaitlistStatus.WAITING, "entered_minutes_ago": 5},
            {"quantity": 2, "status": WaitlistStatus.WAITING, "entered_minutes_ago": 4},
        ],
    )

    result = check_payment_expiry.run()
    assert result["reallocated"] == 1

    with TestSyncSession() as session:
        entries = (
            session.execute(
                select(WaitlistEntryModel).where(WaitlistEntryModel.tier_id == data["tier_id"])
            )
            .scalars()
            .all()
        )
        status_by_user = {entry.user_id: entry.status for entry in entries}
        assert status_by_user[data["waiter_ids"][0]] == WaitlistStatus.OFFERED
        assert status_by_user[data["waiter_ids"][1]] == WaitlistStatus.WAITING

        tier = session.execute(select(SeatTier).where(SeatTier.id == data["tier_id"])).scalar_one()
        assert tier.sold_count == 1


def test_skip_offered_waitlist():
    data = _seed_expired_order(
        order_quantity=1,
        tier_sold_count=1,
        waiters=[{"quantity": 1, "status": WaitlistStatus.OFFERED}],
    )

    result = check_payment_expiry.run()
    assert result["reallocated"] == 0

    with TestSyncSession() as session:
        entry = session.execute(
            select(WaitlistEntryModel).where(WaitlistEntryModel.user_id == data["waiter_ids"][0])
        ).scalar_one()
        assert entry.status == WaitlistStatus.OFFERED

        waiter_orders = (
            session.execute(
                select(Order).where(
                    Order.user_id == data["waiter_ids"][0],
                    Order.status == OrderStatus.PAYMENT_REQUIRED,
                )
            )
            .scalars()
            .all()
        )
        assert waiter_orders == []


def test_notification_created():
    _seed_expired_order(
        order_quantity=1,
        tier_sold_count=1,
        waiters=[{"quantity": 1, "status": WaitlistStatus.WAITING}],
    )

    check_payment_expiry.run()

    with TestSyncSession() as session:
        noti = session.execute(
            select(NotificationModel).where(NotificationModel.type == "waitlist_offered")
        ).scalar_one_or_none()
        assert noti is not None
        assert "24시간" in noti.message


def test_audit_log_created():
    data = _seed_expired_order(
        order_quantity=1,
        tier_sold_count=1,
        waiters=[{"quantity": 1, "status": WaitlistStatus.WAITING}],
    )

    check_payment_expiry.run()

    with TestSyncSession() as session:
        audit = session.execute(
            select(AuditLog).where(AuditLog.action == "waitlist_reallocation")
        ).scalar_one_or_none()
        assert audit is not None
        assert audit.new_value["expired_order_id"] == str(data["expired_order_id"])


def test_expired_order_releases_assigned_seats():
    data = _seed_expired_order(
        order_quantity=2,
        tier_sold_count=2,
        waiters=[],
        with_assigned_seats=True,
    )

    result = check_payment_expiry.run()
    assert result["expired_orders"] == 1

    with TestSyncSession() as session:
        seats = (
            session.execute(select(Seat).where(Seat.id.in_(data["seat_ids"])))
            .scalars()
            .all()
        )
        assert len(seats) == 2
        assert all(seat.status == SeatStatus.AVAILABLE for seat in seats)
