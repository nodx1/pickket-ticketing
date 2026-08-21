#!/usr/bin/env python3
"""Pickket 로컬 비즈니스 플로우 시드.

seed_demo.py가 먼저 실행된 상태를 전제로, 로컬 개발 환경에서 실제 사용자
여정을 재현하는 팬 계정/주문/티켓/팬클럽/상호작용 데이터를 생성한다.

Usage:
    cd backend && .venv/bin/python scripts/seed_local.py
    cd backend && .venv/bin/python scripts/seed_local.py --clean
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import create_engine, delete, false, or_, select
from sqlalchemy.orm import sessionmaker

SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SCRIPT_DIR.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.attendance import Attendance  # noqa: E402
from app.models.attendance_record import AttendanceRecord, AttendanceStreak  # noqa: E402
from app.models.bid import Bid, BidStatus  # noqa: E402
from app.models.event import Event, EventStatus, SeatTier  # noqa: E402
from app.models.fanclub import (  # noqa: E402
    CommunityType,
    Fanclub,
    FanclubMembership,
    MembershipStatus,
    MembershipTier,
)
from app.models.interaction import InteractionType, UserInteraction  # noqa: E402
from app.models.order import Order, OrderStatus, OrderType  # noqa: E402
from app.models.ownership_transfer import (  # noqa: E402
    OwnershipTransfer,
    TransferType,
)
from app.models.phase_config import PhaseConfig  # noqa: E402
from app.models.point import PointTransaction, PointWallet, PointType  # noqa: E402
from app.models.refund import Refund, RefundItem, RefundStatus, RefundType  # noqa: E402
from app.models.resale import ResaleListingModel, ResaleListingStatus  # noqa: E402
from app.models.review import Review  # noqa: E402
from app.models.seat import Seat  # noqa: E402
from app.models.ticket import Ticket, TicketStatus  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.venue import Venue  # noqa: E402
from app.models.waitlist import WaitlistEntryModel, WaitlistStatus  # noqa: E402

TEST_DOMAIN = "@test.pickket.kr"
SEED_PASSWORD = "PickketTest2026!"
SEED_MARKER = "seed-local"
LOCAL_PREFIX = "[LOCAL]"
LOCAL_FCFS_EVENT_TITLE = f"{LOCAL_PREFIX} FCFS Open Run Demo"
LOCAL_ARCHIVE_EVENT_TITLE = f"{LOCAL_PREFIX} Archive Status Demo"
LOCAL_FANCLUB_PREFIX = f"{LOCAL_PREFIX} Fanclub"

FAN_SPECS = [
    ("fan1@test.pickket.kr", "로컬 팬 1", "won_confirmed_active"),
    ("fan2@test.pickket.kr", "로컬 팬 2", "lost_waitlist"),
    ("fan3@test.pickket.kr", "로컬 팬 3", "payment_required"),
    ("fan4@test.pickket.kr", "로컬 팬 4", "refunded"),
    ("fan5@test.pickket.kr", "로컬 팬 5", "resale"),
]


def _resolve_sync_database_url() -> str:
    url = settings.DATABASE_URL or settings.DATABASE_URL_SYNC
    return (
        url.replace("postgresql+asyncpg://", "postgresql://")
        .replace("postgresql+psycopg://", "postgresql://")
        .replace("sqlite+aiosqlite://", "sqlite://")
    )


SEED_SYNC_DATABASE_URL = _resolve_sync_database_url()
SeedSyncSession = sessionmaker(bind=create_engine(SEED_SYNC_DATABASE_URL, pool_pre_ping=True))


def stable_uuid(name: str) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"pickket://seed-local/{name}")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def qr_hash(name: str) -> str:
    return hashlib.sha256(f"{SEED_MARKER}:{name}".encode("utf-8")).hexdigest()


def ensure_user(session, *, email: str, name: str, role_hint: str) -> User:
    user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    hashed = hash_password(SEED_PASSWORD)
    if user:
        user.name = name
        user.hashed_password = hashed
        user.is_active = True
        user.is_verified = True
        user.verification_level = max(user.verification_level or 0, 2)
        user.membership_tier = "supporter"
        user.bio = f"Local seed user ({role_hint})"
        user.phone = user.phone or f"010-0000-{int(email[3]) * 1111:04d}"
        return user

    user = User(
        email=email,
        hashed_password=hashed,
        name=name,
        phone=f"010-0000-{int(email[3]) * 1111:04d}",
        is_verified=True,
        is_active=True,
        verification_level=2,
        preferred_language="ko",
        timezone="Asia/Seoul",
        membership_tier="supporter",
        bio=f"Local seed user ({role_hint})",
    )
    session.add(user)
    session.flush()
    return user


def ensure_point_wallets(session, user: User) -> None:
    for point_type, balance in ((PointType.FAN, 240), (PointType.SOCIAL, 90)):
        wallet = session.execute(
            select(PointWallet).where(
                PointWallet.user_id == user.id,
                PointWallet.point_type == point_type,
            )
        ).scalar_one_or_none()
        if wallet:
            continue
        session.add(
            PointWallet(
                user_id=user.id,
                point_type=point_type,
                balance=balance,
                lifetime_earned=balance,
                lifetime_spent=0,
            )
        )


def get_first_events(session, minimum: int = 5) -> list[Event]:
    events = (
        session.execute(select(Event).order_by(Event.created_at.asc(), Event.title.asc()))
        .scalars()
        .all()
    )
    if len(events) < minimum:
        raise RuntimeError(
            "seed_demo.py가 먼저 실행되어야 합니다. 기존 이벤트가 충분하지 않습니다."
        )
    return events


def get_first_tier(session, event_id: uuid.UUID) -> SeatTier:
    tier = (
        session.execute(
            select(SeatTier)
            .where(SeatTier.event_id == event_id)
            .order_by(SeatTier.base_price.asc(), SeatTier.name.asc())
        )
        .scalars()
        .first()
    )
    if not tier:
        raise RuntimeError(f"Event {event_id} has no seat tiers. Run seed_demo.py first.")
    return tier


def get_or_create_local_event(
    session,
    *,
    title: str,
    organizer_id: uuid.UUID,
    venue: Venue,
    event_date: datetime,
    bidding_opens_at: datetime,
    bidding_closes_at: datetime,
    status: EventStatus,
    description: str,
    current_phase: str,
    image_url: str | None,
    thumbnail_url: str | None,
) -> Event:
    event = session.execute(select(Event).where(Event.title == title)).scalar_one_or_none()
    if event:
        event.organizer_id = organizer_id
        event.venue = venue.name
        event.venue_id = venue.id
        event.event_date = event_date
        event.event_date_end = event_date + timedelta(hours=3)
        event.bidding_opens_at = bidding_opens_at
        event.bidding_closes_at = bidding_closes_at
        event.total_seats = 600
        event.min_price = 77000
        event.max_price = 132000
        event.category = "concert"
        event.status = status
        event.location_city = getattr(venue, "city", "서울")
        event.artist_name = event.artist_name or "로컬 데모 아티스트"
        event.current_phase = current_phase
        event.image_url = image_url
        event.thumbnail_url = thumbnail_url
        event.description = description
        return event

    event = Event(
        id=stable_uuid(title),
        organizer_id=organizer_id,
        title=title,
        description=description,
        venue=venue.name,
        venue_id=venue.id,
        event_date=event_date,
        event_date_end=event_date + timedelta(hours=3),
        bidding_opens_at=bidding_opens_at,
        bidding_closes_at=bidding_closes_at,
        total_seats=600,
        min_price=77000,
        max_price=132000,
        category="concert",
        status=status,
        location_city=getattr(venue, "city", "서울"),
        artist_name="로컬 데모 아티스트",
        image_url=image_url,
        thumbnail_url=thumbnail_url,
        current_phase=current_phase,
        is_featured=False,
        view_count=321,
        bid_count=89,
        seat_type="general",
        delivery_method="mobile",
        mobile_ticket_enabled=True,
        resale_enabled=True,
        resale_max_markup_pct=10.0,
        currency="KRW",
        event_timezone="Asia/Seoul",
    )
    session.add(event)
    session.flush()
    return event


def ensure_tier(
    session,
    *,
    event_id: uuid.UUID,
    name: str,
    base_price: float,
    capacity: int,
    sale_mode: str,
    seating_type: str = "general",
    section_name: str | None = None,
) -> SeatTier:
    tier = session.execute(
        select(SeatTier).where(SeatTier.event_id == event_id, SeatTier.name == name)
    ).scalar_one_or_none()
    if tier:
        tier.base_price = base_price
        tier.face_price = base_price
        tier.capacity = capacity
        tier.sale_mode = sale_mode
        tier.seating_type = seating_type
        tier.section_name = section_name
        return tier

    tier = SeatTier(
        event_id=event_id,
        name=name,
        capacity=capacity,
        base_price=base_price,
        face_price=base_price,
        min_price=base_price,
        max_price_cap=base_price * 1.3,
        sale_mode=sale_mode,
        seating_type=seating_type,
        section_name=section_name,
        sold_count=0,
        fanclub_discount_pct=10.0 if sale_mode == "fanclub_presale" else 0.0,
        resale_allowed=True,
        resale_max_price=base_price * 1.1,
    )
    session.add(tier)
    session.flush()
    return tier


def ensure_phase(session, *, event_id: uuid.UUID, phase: str, starts_at: datetime, ends_at: datetime, sort_order: int, applicable_tier_ids: list[uuid.UUID] | None = None) -> PhaseConfig:
    config = session.execute(
        select(PhaseConfig).where(PhaseConfig.event_id == event_id, PhaseConfig.phase == phase)
    ).scalar_one_or_none()
    serialized = json.dumps([str(tid) for tid in applicable_tier_ids]) if applicable_tier_ids else None
    if config:
        config.starts_at = starts_at
        config.ends_at = ends_at
        config.sort_order = sort_order
        config.applicable_tier_ids = serialized
        return config

    config = PhaseConfig(
        event_id=event_id,
        phase=phase,
        starts_at=starts_at,
        ends_at=ends_at,
        applicable_tier_ids=serialized,
        sort_order=sort_order,
    )
    session.add(config)
    session.flush()
    return config


def ensure_bid(
    session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    status: BidStatus,
    price: float,
    quantity: int = 1,
    effective_weight: float | None = None,
) -> Bid:
    bid = session.execute(
        select(Bid).where(Bid.user_id == user_id, Bid.event_id == event_id, Bid.tier_id == tier_id)
    ).scalar_one_or_none()
    if bid:
        bid.status = status
        bid.max_willingness_to_pay = price
        bid.quantity = quantity
        bid.effective_weight = effective_weight
        bid.updated_at = utc_now()
        return bid

    bid = Bid(
        user_id=user_id,
        event_id=event_id,
        tier_id=tier_id,
        max_willingness_to_pay=price,
        quantity=quantity,
        status=status,
        effective_weight=effective_weight,
    )
    session.add(bid)
    session.flush()
    return bid


def ensure_order(
    session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    payment_id: str,
    status: OrderStatus,
    amount: float,
    quantity: int = 1,
    created_at: datetime | None = None,
    payment_deadline: datetime | None = None,
    captured_at: datetime | None = None,
    total_refunded: float = 0.0,
    payment_failed_reason: str | None = None,
    metadata: dict | None = None,
) -> Order:
    order = session.execute(select(Order).where(Order.payment_id == payment_id)).scalar_one_or_none()
    timestamp = created_at or utc_now()
    if order:
        order.user_id = user_id
        order.event_id = event_id
        order.tier_id = tier_id
        order.status = status
        order.quantity = quantity
        order.unit_price = amount
        order.total_amount = amount * quantity
        order.payment_deadline = payment_deadline
        order.captured_at = captured_at
        order.authorized_at = captured_at
        order.pg_approved_at = captured_at
        order.total_refunded = total_refunded
        order.payment_failed_reason = payment_failed_reason
        order.payment_metadata = metadata
        return order

    order = Order(
        user_id=user_id,
        event_id=event_id,
        tier_id=tier_id,
        order_type=OrderType.PURCHASE,
        status=status,
        quantity=quantity,
        unit_price=amount,
        total_amount=amount * quantity,
        payment_id=payment_id,
        payment_idempotency_key=f"{payment_id}-idem",
        pg_provider="portone",
        pg_transaction_id=f"{payment_id}-pgx" if status in {OrderStatus.CONFIRMED, OrderStatus.REFUNDED} else None,
        pg_approved_at=captured_at,
        authorized_at=captured_at,
        captured_at=captured_at,
        payment_deadline=payment_deadline,
        payment_failed_reason=payment_failed_reason,
        payment_metadata=metadata,
        total_refunded=total_refunded,
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(order)
    session.flush()
    return order


def ensure_ticket(
    session,
    *,
    ticket_key: str,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    owner_id: uuid.UUID,
    original_owner_id: uuid.UUID,
    status: TicketStatus,
    purchase_order_id: uuid.UUID | None,
    purchase_price: float,
    sale_mode: str,
    qr_code_hash: str | None = None,
    is_resalable: bool = True,
    resale_max_price: float = 0.0,
    transfer_count: int = 0,
) -> Ticket:
    nfc_uid = f"{SEED_MARKER}-{ticket_key}"
    ticket = session.execute(select(Ticket).where(Ticket.nfc_uid == nfc_uid)).scalar_one_or_none()
    if ticket:
        ticket.event_id = event_id
        ticket.tier_id = tier_id
        ticket.current_owner_id = owner_id
        ticket.original_owner_id = original_owner_id
        ticket.purchase_order_id = purchase_order_id
        ticket.purchase_price = purchase_price
        ticket.sale_mode = sale_mode
        ticket.status = status
        ticket.qr_code_hash = qr_code_hash
        ticket.is_resalable = is_resalable
        ticket.resale_max_price = resale_max_price
        ticket.transfer_count = transfer_count
        return ticket

    ticket = Ticket(
        event_id=event_id,
        tier_id=tier_id,
        original_owner_id=original_owner_id,
        current_owner_id=owner_id,
        purchase_price=purchase_price,
        sale_mode=sale_mode,
        purchase_order_id=purchase_order_id,
        status=status,
        qr_code_hash=qr_code_hash,
        nfc_uid=nfc_uid,
        identity_verified=True,
        is_resalable=is_resalable,
        resale_max_price=resale_max_price,
        transfer_count=transfer_count,
    )
    session.add(ticket)
    session.flush()
    return ticket


def ensure_primary_sale_transfer(session, *, ticket: Ticket, to_user_id: uuid.UUID, price: float) -> OwnershipTransfer:
    transfer = session.execute(
        select(OwnershipTransfer).where(
            OwnershipTransfer.ticket_id == ticket.id,
            OwnershipTransfer.transfer_type == TransferType.PRIMARY_SALE,
            OwnershipTransfer.to_user_id == to_user_id,
        )
    ).scalar_one_or_none()
    if transfer:
        transfer.price = price
        transfer.completed_at = transfer.completed_at or utc_now()
        return transfer

    transfer = OwnershipTransfer(
        ticket_id=ticket.id,
        from_user_id=None,
        to_user_id=to_user_id,
        transfer_type=TransferType.PRIMARY_SALE,
        price=price,
        seller_amount=0.0,
        platform_fee=0.0,
        artist_royalty=0.0,
        status="completed",
        initiated_at=utc_now(),
        completed_at=utc_now(),
        buyer_phone_verified=True,
    )
    session.add(transfer)
    session.flush()
    return transfer


def ensure_transfer(
    session,
    *,
    ticket: Ticket,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
    transfer_code: str,
) -> OwnershipTransfer:
    transfer = session.execute(
        select(OwnershipTransfer).where(OwnershipTransfer.transfer_code == transfer_code)
    ).scalar_one_or_none()
    if transfer:
        transfer.ticket_id = ticket.id
        transfer.from_user_id = from_user_id
        transfer.to_user_id = to_user_id
        transfer.completed_at = transfer.completed_at or utc_now()
        return transfer

    transfer = OwnershipTransfer(
        ticket_id=ticket.id,
        from_user_id=from_user_id,
        to_user_id=to_user_id,
        transfer_type=TransferType.GIFT,
        price=0.0,
        seller_amount=0.0,
        platform_fee=0.0,
        artist_royalty=0.0,
        status="completed",
        initiated_at=utc_now() - timedelta(days=10),
        completed_at=utc_now() - timedelta(days=10),
        buyer_phone_verified=True,
        transfer_code=transfer_code,
    )
    session.add(transfer)
    session.flush()
    return transfer


def ensure_attendance(session, *, ticket: Ticket, event_id: uuid.UUID, user_id: uuid.UUID, checked_in_by: uuid.UUID | None = None) -> Attendance:
    attendance = session.execute(select(Attendance).where(Attendance.ticket_id == ticket.id)).scalar_one_or_none()
    if attendance:
        attendance.event_id = event_id
        attendance.user_id = user_id
        attendance.checked_in_by = checked_in_by
        attendance.method = "qr_scan"
        return attendance

    attendance = Attendance(
        ticket_id=ticket.id,
        event_id=event_id,
        user_id=user_id,
        checked_in_by=checked_in_by,
        method="qr_scan",
    )
    session.add(attendance)
    session.flush()
    return attendance


def ensure_refund(
    session,
    *,
    order: Order,
    ticket: Ticket,
    admin_user_id: uuid.UUID | None,
    amount: float,
) -> Refund:
    refund = session.execute(
        select(Refund).where(Refund.idempotency_key == "seed-local-fan4-refund")
    ).scalar_one_or_none()
    if refund:
        refund.order_id = order.id
        refund.status = RefundStatus.COMPLETED.value
        refund.amount = amount
        refund.approved_by = admin_user_id
        refund.approved_at = refund.approved_at or utc_now() - timedelta(days=5)
        refund.processed_at = refund.processed_at or utc_now() - timedelta(days=5)
    else:
        refund = Refund(
            order_id=order.id,
            idempotency_key="seed-local-fan4-refund",
            refund_type=RefundType.FULL.value,
            status=RefundStatus.COMPLETED.value,
            amount=amount,
            currency="KRW",
            reason="Local seed refund demo",
            initiated_by="user",
            initiated_by_user_id=order.user_id,
            requires_approval=True,
            approved_by=admin_user_id,
            approved_at=utc_now() - timedelta(days=5),
            pg_refund_id="seed-local-fan4-refund-pg",
            pg_response={"seed": True, "status": "completed"},
            processed_at=utc_now() - timedelta(days=5),
        )
        session.add(refund)
        session.flush()

    item = session.execute(
        select(RefundItem).where(RefundItem.refund_id == refund.id, RefundItem.ticket_id == ticket.id)
    ).scalar_one_or_none()
    if not item:
        item = RefundItem(
            refund_id=refund.id,
            ticket_id=ticket.id,
            seat_id=ticket.seat_id,
            amount=amount,
            ticket_status_before=TicketStatus.ACTIVE.value,
            ticket_status_after=TicketStatus.CANCELLED.value,
        )
        session.add(item)
        session.flush()
    return refund


def ensure_resale_listing(session, *, ticket: Ticket, seller_id: uuid.UUID, asking_price: float) -> ResaleListingModel:
    listing = session.execute(
        select(ResaleListingModel).where(ResaleListingModel.ticket_id == ticket.id)
    ).scalar_one_or_none()
    if listing:
        listing.status = ResaleListingStatus.ACTIVE
        listing.seller_id = seller_id
        listing.asking_price = asking_price
        listing.seller_receives = asking_price * 0.92
        listing.platform_fee = asking_price * 0.08
        listing.artist_royalty = 0.0
        return listing

    listing = ResaleListingModel(
        ticket_id=ticket.id,
        seller_id=seller_id,
        asking_price=asking_price,
        currency="KRW",
        status=ResaleListingStatus.ACTIVE,
        seller_receives=asking_price * 0.92,
        platform_fee=asking_price * 0.08,
        artist_royalty=0.0,
    )
    session.add(listing)
    session.flush()
    return listing


def ensure_review(
    session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    rating: int,
    title: str,
    content: str,
    verified: bool,
) -> Review:
    review = session.execute(
        select(Review).where(
            Review.user_id == user_id,
            Review.event_id == event_id,
            Review.title == title,
        )
    ).scalar_one_or_none()
    if review:
        review.rating = rating
        review.content = content
        review.is_verified_attendee = verified
        return review

    review = Review(
        user_id=user_id,
        event_id=event_id,
        rating=rating,
        title=title,
        content=content,
        is_verified_attendee=verified,
        helpful_count=rating * 3,
    )
    session.add(review)
    session.flush()
    return review


def ensure_interaction(
    session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    interaction_type: InteractionType,
    metadata: dict,
) -> UserInteraction:
    meta = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
    interaction = session.execute(
        select(UserInteraction).where(
            UserInteraction.user_id == user_id,
            UserInteraction.event_id == event_id,
            UserInteraction.interaction_type == interaction_type.value,
        )
    ).scalar_one_or_none()
    if interaction:
        interaction.metadata_json = meta
        return interaction

    interaction = UserInteraction(
        user_id=user_id,
        event_id=event_id,
        interaction_type=interaction_type.value,
        metadata_json=meta,
        created_at=utc_now().replace(tzinfo=None),
    )
    session.add(interaction)
    session.flush()
    return interaction


def ensure_waitlist_entry(
    session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    priority_score: float,
    quantity: int,
) -> WaitlistEntryModel:
    entry = session.execute(
        select(WaitlistEntryModel).where(
            WaitlistEntryModel.user_id == user_id,
            WaitlistEntryModel.tier_id == tier_id,
        )
    ).scalar_one_or_none()
    if entry:
        entry.event_id = event_id
        entry.priority_score = priority_score
        entry.quantity = quantity
        entry.status = WaitlistStatus.WAITING
        return entry

    entry = WaitlistEntryModel(
        user_id=user_id,
        event_id=event_id,
        tier_id=tier_id,
        priority_score=priority_score,
        quantity=quantity,
        group_size=1,
        status=WaitlistStatus.WAITING,
    )
    session.add(entry)
    session.flush()
    return entry


def ensure_fanclub(session, *, artist_name: str, organizer_id: uuid.UUID) -> Fanclub:
    name = f"{LOCAL_FANCLUB_PREFIX} {artist_name}"
    fanclub = session.execute(select(Fanclub).where(Fanclub.name == name)).scalar_one_or_none()
    if fanclub:
        fanclub.artist_name = artist_name
        fanclub.organizer_id = organizer_id
        fanclub.is_official = True
        fanclub.is_active = True
        return fanclub

    fanclub = Fanclub(
        id=stable_uuid(name),
        name=name,
        artist_name=artist_name,
        description="Local seed fanclub for dev/QA flows",
        organizer_id=organizer_id,
        max_members=10000,
        is_official=True,
        is_active=True,
        community_type=CommunityType.FANCLUB.value,
        subject_name=artist_name,
        domain="concert",
        custom_member_label="캐럿",
        event_type_template="fanclub_exclusive",
    )
    session.add(fanclub)
    session.flush()
    return fanclub


def ensure_membership(session, *, fanclub_id: uuid.UUID, user_id: uuid.UUID, tier: MembershipTier, membership_code: str) -> FanclubMembership:
    membership = session.execute(
        select(FanclubMembership).where(
            FanclubMembership.fanclub_id == fanclub_id,
            FanclubMembership.user_id == user_id,
        )
    ).scalar_one_or_none()
    if membership:
        membership.status = MembershipStatus.ACTIVE.value
        membership.tier = tier.value
        membership.membership_code = membership_code
        membership.verified_at = membership.verified_at or utc_now() - timedelta(days=20)
        membership.expires_at = utc_now() + timedelta(days=365)
        return membership

    membership = FanclubMembership(
        fanclub_id=fanclub_id,
        user_id=user_id,
        tier=tier.value,
        status=MembershipStatus.ACTIVE.value,
        membership_code=membership_code,
        verified_at=utc_now() - timedelta(days=20),
        expires_at=utc_now() + timedelta(days=365),
        is_organizer_affiliated=False,
    )
    session.add(membership)
    session.flush()
    return membership


def cleanup_local_seed(session) -> None:
    test_user_ids = session.execute(
        select(User.id).where(User.email.like(f"%{TEST_DOMAIN}"))
    ).scalars().all()
    local_event_ids = session.execute(
        select(Event.id).where(Event.title.like(f"{LOCAL_PREFIX}%"))
    ).scalars().all()
    local_tier_ids = session.execute(
        select(SeatTier.id).where(SeatTier.event_id.in_(local_event_ids) if local_event_ids else false())
    ).scalars().all()
    local_fanclub_ids = session.execute(
        select(Fanclub.id).where(Fanclub.name.like(f"{LOCAL_PREFIX}%"))
    ).scalars().all()
    order_ids = session.execute(
        select(Order.id).where(
            or_(
                Order.user_id.in_(test_user_ids) if test_user_ids else false(),
                Order.event_id.in_(local_event_ids) if local_event_ids else false(),
            )
        )
    ).scalars().all()
    ticket_ids = session.execute(
        select(Ticket.id).where(
            or_(
                Ticket.current_owner_id.in_(test_user_ids) if test_user_ids else false(),
                Ticket.original_owner_id.in_(test_user_ids) if test_user_ids else false(),
                Ticket.purchase_order_id.in_(order_ids) if order_ids else false(),
                Ticket.event_id.in_(local_event_ids) if local_event_ids else false(),
            )
        )
    ).scalars().all()
    refund_ids = session.execute(
        select(Refund.id).where(Refund.order_id.in_(order_ids) if order_ids else false())
    ).scalars().all()

    if refund_ids:
        session.execute(delete(RefundItem).where(RefundItem.refund_id.in_(refund_ids)))
        session.execute(delete(Refund).where(Refund.id.in_(refund_ids)))
    if ticket_ids:
        session.execute(delete(ResaleListingModel).where(ResaleListingModel.ticket_id.in_(ticket_ids)))
        session.execute(delete(Attendance).where(Attendance.ticket_id.in_(ticket_ids)))
        session.execute(delete(OwnershipTransfer).where(OwnershipTransfer.ticket_id.in_(ticket_ids)))
    if test_user_ids:
        session.execute(delete(OwnershipTransfer).where(
            OwnershipTransfer.from_user_id.in_(test_user_ids) | OwnershipTransfer.to_user_id.in_(test_user_ids)
        ))
        session.execute(delete(PointTransaction).where(PointTransaction.user_id.in_(test_user_ids)))
        session.execute(delete(PointWallet).where(PointWallet.user_id.in_(test_user_ids)))
        session.execute(delete(AttendanceRecord).where(AttendanceRecord.user_id.in_(test_user_ids)))
        session.execute(delete(AttendanceStreak).where(AttendanceStreak.user_id.in_(test_user_ids)))
        session.execute(delete(Review).where(Review.user_id.in_(test_user_ids)))
        session.execute(delete(UserInteraction).where(UserInteraction.user_id.in_(test_user_ids)))
        session.execute(delete(FanclubMembership).where(FanclubMembership.user_id.in_(test_user_ids)))
        session.execute(delete(WaitlistEntryModel).where(WaitlistEntryModel.user_id.in_(test_user_ids)))
        session.execute(delete(Bid).where(Bid.user_id.in_(test_user_ids)))
    if ticket_ids:
        session.execute(delete(Ticket).where(Ticket.id.in_(ticket_ids)))
    if order_ids:
        session.execute(delete(Order).where(Order.id.in_(order_ids)))
    if local_tier_ids:
        session.execute(delete(WaitlistEntryModel).where(WaitlistEntryModel.tier_id.in_(local_tier_ids)))
        session.execute(delete(Seat).where(Seat.tier_id.in_(local_tier_ids)))
    if local_event_ids:
        session.execute(delete(PhaseConfig).where(PhaseConfig.event_id.in_(local_event_ids)))
        session.execute(delete(Review).where(Review.event_id.in_(local_event_ids)))
        session.execute(delete(UserInteraction).where(UserInteraction.event_id.in_(local_event_ids)))
        session.execute(delete(Bid).where(Bid.event_id.in_(local_event_ids)))
        session.execute(delete(SeatTier).where(SeatTier.event_id.in_(local_event_ids)))
        session.execute(delete(Event).where(Event.id.in_(local_event_ids)))
    if local_fanclub_ids:
        session.execute(delete(FanclubMembership).where(FanclubMembership.fanclub_id.in_(local_fanclub_ids)))
        session.execute(delete(Fanclub).where(Fanclub.id.in_(local_fanclub_ids)))
    if test_user_ids:
        session.execute(delete(User).where(User.id.in_(test_user_ids)))
    session.commit()


def seed_local(session) -> None:
    now = utc_now()
    events = get_first_events(session)
    base_event = events[0]
    venue = None
    if base_event.venue_id:
        venue = session.execute(select(Venue).where(Venue.id == base_event.venue_id)).scalar_one_or_none()
    if venue is None:
        venue = session.execute(select(Venue).order_by(Venue.name.asc())).scalars().first()
    if venue is None:
        raise RuntimeError("No venues found. Run seed_demo.py first.")

    admin_user = session.execute(select(User).where(User.email == "admin@pickket.kr")).scalar_one_or_none()
    fans: dict[str, User] = {}
    for email, name, role_hint in FAN_SPECS:
        user = ensure_user(session, email=email, name=name, role_hint=role_hint)
        ensure_point_wallets(session, user)
        fans[email] = user

    lottery_event = events[0]
    payment_event = events[1]
    refund_event = events[2]
    resale_event = events[3]
    review_events = events[:5]

    lottery_tier = get_first_tier(session, lottery_event.id)
    payment_tier = get_first_tier(session, payment_event.id)
    refund_tier = get_first_tier(session, refund_event.id)
    resale_tier = get_first_tier(session, resale_event.id)

    local_fcfs_event = get_or_create_local_event(
        session,
        title=LOCAL_FCFS_EVENT_TITLE,
        organizer_id=base_event.organizer_id,
        venue=venue,
        event_date=now + timedelta(days=14),
        bidding_opens_at=now - timedelta(minutes=30),
        bidding_closes_at=now + timedelta(days=2),
        status=EventStatus.BIDDING_OPEN,
        description="Local seed용 선착순/대기열 검증 이벤트",
        current_phase="public_sale",
        image_url=base_event.image_url,
        thumbnail_url=base_event.thumbnail_url,
    )
    local_archive_event = get_or_create_local_event(
        session,
        title=LOCAL_ARCHIVE_EVENT_TITLE,
        organizer_id=base_event.organizer_id,
        venue=venue,
        event_date=now - timedelta(days=21),
        bidding_opens_at=now - timedelta(days=40),
        bidding_closes_at=now - timedelta(days=22),
        status=EventStatus.COMPLETED,
        description="Local seed용 과거 티켓 상태/검표 검증 이벤트",
        current_phase="completed",
        image_url=base_event.image_url,
        thumbnail_url=base_event.thumbnail_url,
    )
    fcfs_r_tier = ensure_tier(
        session,
        event_id=local_fcfs_event.id,
        name="R석",
        base_price=132000,
        capacity=300,
        sale_mode="fixed_fcfs",
        section_name="R",
    )
    fcfs_s_tier = ensure_tier(
        session,
        event_id=local_fcfs_event.id,
        name="S석",
        base_price=99000,
        capacity=300,
        sale_mode="fixed_fcfs",
        section_name="S",
    )
    archive_tier = ensure_tier(
        session,
        event_id=local_archive_event.id,
        name="Archive R",
        base_price=88000,
        capacity=120,
        sale_mode="fixed_fcfs",
        section_name="AR",
    )

    ensure_phase(
        session,
        event_id=local_fcfs_event.id,
        phase="queue_open",
        starts_at=now - timedelta(hours=1),
        ends_at=now + timedelta(hours=2),
        sort_order=0,
        applicable_tier_ids=[fcfs_r_tier.id, fcfs_s_tier.id],
    )
    ensure_phase(
        session,
        event_id=local_fcfs_event.id,
        phase="public_sale",
        starts_at=now - timedelta(minutes=15),
        ends_at=now + timedelta(hours=2),
        sort_order=1,
        applicable_tier_ids=[fcfs_r_tier.id, fcfs_s_tier.id],
    )

    fanclub = ensure_fanclub(
        session,
        artist_name=base_event.artist_name or base_event.subject_name or base_event.title,
        organizer_id=base_event.organizer_id,
    )
    membership_tiers = [
        MembershipTier.VIP,
        MembershipTier.PREMIUM,
        MembershipTier.BASIC,
        MembershipTier.BASIC,
        MembershipTier.PREMIUM,
    ]
    for (email, _, _), tier in zip(FAN_SPECS, membership_tiers, strict=False):
        ensure_membership(
            session,
            fanclub_id=fanclub.id,
            user_id=fans[email].id,
            tier=tier,
            membership_code=f"LOCAL-{email.split('@', 1)[0].upper()}",
        )

    ensure_bid(
        session,
        user_id=fans["fan1@test.pickket.kr"].id,
        event_id=lottery_event.id,
        tier_id=lottery_tier.id,
        status=BidStatus.WON,
        price=lottery_tier.face_price or lottery_tier.base_price,
        effective_weight=1.48,
    )
    ensure_bid(
        session,
        user_id=fans["fan2@test.pickket.kr"].id,
        event_id=lottery_event.id,
        tier_id=lottery_tier.id,
        status=BidStatus.LOST,
        price=lottery_tier.face_price or lottery_tier.base_price,
        effective_weight=1.05,
    )

    fan1_order = ensure_order(
        session,
        user_id=fans["fan1@test.pickket.kr"].id,
        event_id=lottery_event.id,
        tier_id=lottery_tier.id,
        payment_id="seed-local-fan1-confirmed",
        status=OrderStatus.CONFIRMED,
        amount=lottery_tier.face_price or lottery_tier.base_price,
        captured_at=now - timedelta(days=1),
        metadata={"seed_local": True, "scenario": "won_confirmed_active"},
    )
    ensure_order(
        session,
        user_id=fans["fan2@test.pickket.kr"].id,
        event_id=payment_event.id,
        tier_id=payment_tier.id,
        payment_id="seed-local-fan2-pending",
        status=OrderStatus.PENDING,
        amount=payment_tier.face_price or payment_tier.base_price,
        metadata={"seed_local": True, "scenario": "pending"},
    )
    fan3_order = ensure_order(
        session,
        user_id=fans["fan3@test.pickket.kr"].id,
        event_id=payment_event.id,
        tier_id=payment_tier.id,
        payment_id="seed-local-fan3-payment-required",
        status=OrderStatus.PAYMENT_REQUIRED,
        amount=payment_tier.face_price or payment_tier.base_price,
        payment_deadline=now + timedelta(minutes=25),
        metadata={"seed_local": True, "scenario": "payment_required"},
    )
    fan2_expired_order = ensure_order(
        session,
        user_id=fans["fan2@test.pickket.kr"].id,
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        payment_id="seed-local-fan2-expired",
        status=OrderStatus.EXPIRED,
        amount=archive_tier.face_price or archive_tier.base_price,
        payment_deadline=now - timedelta(days=12),
        payment_failed_reason="local seed payment timeout",
        metadata={"seed_local": True, "scenario": "payment_required_to_expired"},
    )
    fan4_order = ensure_order(
        session,
        user_id=fans["fan4@test.pickket.kr"].id,
        event_id=refund_event.id,
        tier_id=refund_tier.id,
        payment_id="seed-local-fan4-refunded",
        status=OrderStatus.REFUNDED,
        amount=refund_tier.face_price or refund_tier.base_price,
        captured_at=now - timedelta(days=6),
        total_refunded=refund_tier.face_price or refund_tier.base_price,
        metadata={"seed_local": True, "scenario": "confirmed_to_refunded"},
    )
    fan5_order = ensure_order(
        session,
        user_id=fans["fan5@test.pickket.kr"].id,
        event_id=resale_event.id,
        tier_id=resale_tier.id,
        payment_id="seed-local-fan5-confirmed",
        status=OrderStatus.CONFIRMED,
        amount=resale_tier.face_price or resale_tier.base_price,
        captured_at=now - timedelta(days=2),
        metadata={"seed_local": True, "scenario": "confirmed_to_resale"},
    )
    used_order = ensure_order(
        session,
        user_id=fans["fan1@test.pickket.kr"].id,
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        payment_id="seed-local-fan1-used",
        status=OrderStatus.CONFIRMED,
        amount=archive_tier.face_price or archive_tier.base_price,
        captured_at=now - timedelta(days=20),
        metadata={"seed_local": True, "scenario": "used_ticket"},
    )
    transfer_source_order = ensure_order(
        session,
        user_id=fans["fan5@test.pickket.kr"].id,
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        payment_id="seed-local-fan5-transfer-source",
        status=OrderStatus.CONFIRMED,
        amount=archive_tier.face_price or archive_tier.base_price,
        captured_at=now - timedelta(days=12),
        metadata={"seed_local": True, "scenario": "transfer_source"},
    )

    fan1_active_ticket = ensure_ticket(
        session,
        ticket_key="fan1-active",
        event_id=lottery_event.id,
        tier_id=lottery_tier.id,
        owner_id=fans["fan1@test.pickket.kr"].id,
        original_owner_id=fans["fan1@test.pickket.kr"].id,
        status=TicketStatus.ACTIVE,
        purchase_order_id=fan1_order.id,
        purchase_price=lottery_tier.face_price or lottery_tier.base_price,
        sale_mode="lottery",
        qr_code_hash=qr_hash("fan1-valid"),
        is_resalable=True,
        resale_max_price=(lottery_tier.face_price or lottery_tier.base_price) * 1.05,
    )
    used_ticket = ensure_ticket(
        session,
        ticket_key="fan1-used",
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        owner_id=fans["fan1@test.pickket.kr"].id,
        original_owner_id=fans["fan1@test.pickket.kr"].id,
        status=TicketStatus.USED,
        purchase_order_id=used_order.id,
        purchase_price=archive_tier.face_price or archive_tier.base_price,
        sale_mode="fixed_fcfs",
        is_resalable=False,
        transfer_count=0,
    )
    refund_ticket = ensure_ticket(
        session,
        ticket_key="fan4-cancelled",
        event_id=refund_event.id,
        tier_id=refund_tier.id,
        owner_id=fans["fan4@test.pickket.kr"].id,
        original_owner_id=fans["fan4@test.pickket.kr"].id,
        status=TicketStatus.CANCELLED,
        purchase_order_id=fan4_order.id,
        purchase_price=refund_tier.face_price or refund_tier.base_price,
        sale_mode="fixed_fcfs",
        is_resalable=False,
    )
    resale_ticket = ensure_ticket(
        session,
        ticket_key="fan5-resale",
        event_id=resale_event.id,
        tier_id=resale_tier.id,
        owner_id=fans["fan5@test.pickket.kr"].id,
        original_owner_id=fans["fan5@test.pickket.kr"].id,
        status=TicketStatus.ACTIVE,
        purchase_order_id=fan5_order.id,
        purchase_price=resale_tier.face_price or resale_tier.base_price,
        sale_mode="fixed_fcfs",
        is_resalable=True,
        resale_max_price=(resale_tier.face_price or resale_tier.base_price) * 1.1,
    )
    transferred_ticket = ensure_ticket(
        session,
        ticket_key="fan5-to-fan3",
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        owner_id=fans["fan3@test.pickket.kr"].id,
        original_owner_id=fans["fan5@test.pickket.kr"].id,
        status=TicketStatus.TRANSFERRED,
        purchase_order_id=transfer_source_order.id,
        purchase_price=archive_tier.face_price or archive_tier.base_price,
        sale_mode="gift_transfer",
        is_resalable=False,
        transfer_count=1,
    )
    expired_ticket = ensure_ticket(
        session,
        ticket_key="fan2-expired",
        event_id=local_archive_event.id,
        tier_id=archive_tier.id,
        owner_id=fans["fan2@test.pickket.kr"].id,
        original_owner_id=fans["fan2@test.pickket.kr"].id,
        status=TicketStatus.EXPIRED,
        purchase_order_id=fan2_expired_order.id,
        purchase_price=archive_tier.face_price or archive_tier.base_price,
        sale_mode="fixed_fcfs",
        qr_code_hash=qr_hash("fan2-expired"),
        is_resalable=False,
    )

    ensure_primary_sale_transfer(
        session,
        ticket=fan1_active_ticket,
        to_user_id=fans["fan1@test.pickket.kr"].id,
        price=lottery_tier.face_price or lottery_tier.base_price,
    )
    ensure_primary_sale_transfer(
        session,
        ticket=used_ticket,
        to_user_id=fans["fan1@test.pickket.kr"].id,
        price=archive_tier.face_price or archive_tier.base_price,
    )
    ensure_primary_sale_transfer(
        session,
        ticket=refund_ticket,
        to_user_id=fans["fan4@test.pickket.kr"].id,
        price=refund_tier.face_price or refund_tier.base_price,
    )
    ensure_primary_sale_transfer(
        session,
        ticket=resale_ticket,
        to_user_id=fans["fan5@test.pickket.kr"].id,
        price=resale_tier.face_price or resale_tier.base_price,
    )
    ensure_primary_sale_transfer(
        session,
        ticket=expired_ticket,
        to_user_id=fans["fan2@test.pickket.kr"].id,
        price=archive_tier.face_price or archive_tier.base_price,
    )
    ensure_primary_sale_transfer(
        session,
        ticket=transferred_ticket,
        to_user_id=fans["fan5@test.pickket.kr"].id,
        price=archive_tier.face_price or archive_tier.base_price,
    )
    ensure_transfer(
        session,
        ticket=transferred_ticket,
        from_user_id=fans["fan5@test.pickket.kr"].id,
        to_user_id=fans["fan3@test.pickket.kr"].id,
        transfer_code="LOC-GIFT-F5-F3",
    )

    ensure_attendance(
        session,
        ticket=used_ticket,
        event_id=local_archive_event.id,
        user_id=fans["fan1@test.pickket.kr"].id,
        checked_in_by=admin_user.id if admin_user else None,
    )
    ensure_refund(
        session,
        order=fan4_order,
        ticket=refund_ticket,
        admin_user_id=admin_user.id if admin_user else None,
        amount=refund_tier.face_price or refund_tier.base_price,
    )
    ensure_resale_listing(
        session,
        ticket=resale_ticket,
        seller_id=fans["fan5@test.pickket.kr"].id,
        asking_price=(resale_tier.face_price or resale_tier.base_price) * 1.07,
    )

    review_specs = [
        ("fan1@test.pickket.kr", review_events[0], 5, f"{LOCAL_PREFIX} 역시 기대 이상", "추첨부터 결제까지 흐름이 깔끔했고 공연 퀄리티도 좋았습니다.", True),
        ("fan2@test.pickket.kr", review_events[1], 4, f"{LOCAL_PREFIX} 좌석 동선이 편했어요", "낙첨은 아쉬웠지만 페이지 정보가 잘 정리되어 있었습니다.", False),
        ("fan4@test.pickket.kr", review_events[2], 5, f"{LOCAL_PREFIX} 환불 케이스 확인", "환불 시나리오 확인용 리뷰입니다. 운영 응대 흐름을 보기 좋습니다.", True),
    ]
    for email, event, rating, title, content, verified in review_specs:
        ensure_review(
            session,
            user_id=fans[email].id,
            event_id=event.id,
            rating=rating,
            title=title,
            content=content,
            verified=verified,
        )

    for idx, (email, _, _) in enumerate(FAN_SPECS):
        favorite_event = review_events[idx % len(review_events)]
        view_event = review_events[(idx + 1) % len(review_events)]
        ensure_interaction(
            session,
            user_id=fans[email].id,
            event_id=favorite_event.id,
            interaction_type=InteractionType.FAVORITE,
            metadata={"seed_local": True, "kind": "favorite", "rank": idx + 1},
        )
        ensure_interaction(
            session,
            user_id=fans[email].id,
            event_id=view_event.id,
            interaction_type=InteractionType.VIEW,
            metadata={"seed_local": True, "kind": "recent_view", "rank": idx + 1},
        )

    waitlist_users = [fans[email] for email, _, _ in FAN_SPECS]
    for idx, user in enumerate(waitlist_users, start=1):
        ensure_waitlist_entry(
            session,
            user_id=user.id,
            event_id=local_fcfs_event.id,
            tier_id=fcfs_r_tier.id,
            priority_score=110 - idx,
            quantity=1,
        )
        ensure_waitlist_entry(
            session,
            user_id=user.id,
            event_id=local_fcfs_event.id,
            tier_id=fcfs_s_tier.id,
            priority_score=95 - idx,
            quantity=1 + (1 if idx % 2 == 0 else 0),
        )

    session.commit()

    print("Local seed complete:")
    print("  - 팬 유저 5명")
    print("  - 주문 8건 (pending/payment_required/confirmed/expired/refunded 포함)")
    print("  - 티켓 6건 (active/used/cancelled/transferred/expired 포함)")
    print("  - 검표 1건, QR 2건")
    print("  - 팬클럽 1개 + 멤버십 5건")
    print("  - waitlist 10건 + local FCFS 이벤트 1건")
    print("  - 리뷰 3건, 즐겨찾기 5건, 최근 본 기록 5건")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed local business-flow data for Pickket.")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete @test.pickket.kr users and related local-seed data before re-seeding.",
    )
    return parser.parse_args()


def main() -> int:
    # 프로덕션 보호(P620 감사 P2-3) — 라이브 DB 에 로컬 시드 계정 잔재 방지.
    import os
    if settings.ENVIRONMENT == "production" and os.environ.get("SEED_ALLOW_PRODUCTION") != "1":
        print("🚫 ENVIRONMENT=production 에서는 로컬 시드를 실행하지 않습니다 "
              "(테스트/데모 계정 잔재 방지). 정말 필요하면 SEED_ALLOW_PRODUCTION=1 로 실행.")
        return 1
    args = parse_args()
    try:
        with SeedSyncSession() as session:
            if args.clean:
                cleanup_local_seed(session)
            seed_local(session)
        return 0
    except RuntimeError as exc:
        print(f"[seed_local] {exc}", file=sys.stderr)
        if "seed_demo.py" in str(exc):
            print("[seed_local] 먼저 'cd backend && .venv/bin/python scripts/seed_demo.py' 를 실행하세요.", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[seed_local] failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
