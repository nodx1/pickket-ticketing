#!/usr/bin/env python3
"""Seed database with demo data for Pickket.

Creates realistic Korean event data including organizers, regular users,
events across all categories, bids on popular events, and resale marketplace
data (tickets, listings, buy orders, ownership transfers).

Idempotent: clears existing seed data before inserting.
"""

import asyncio
import json
import os
import random
import uuid
from datetime import datetime, timezone, timedelta

import bcrypt
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Import models and config
from app.core.config import settings
from app.core.database import Base
from app.models.user import User
from app.models.event import Event, EventStatus, SeatTier
from app.models.bid import Bid, BidStatus
from app.models.allocation import Allocation, AllocationResult
from app.models.interaction import UserInteraction
from app.models.ticket import Ticket, TicketStatus
from app.models.seat import Seat, SeatStatus
from app.models.venue import Venue, VenueSection
from app.models.resale import (
    ResaleListingModel,
    ResaleListingStatus,
    ResaleBuyOrderModel,
    ResaleBuyOrderStatus,
)
from app.models.ownership_transfer import OwnershipTransfer, TransferType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """Hash password using bcrypt -- same as app.core.security.hash_password."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


NOW = datetime.now(timezone.utc)

# Deterministic UUIDs so re-runs are idempotent
ORGANIZER_IDS = [uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-organizer-{i}") for i in range(3)]
USER_IDS = [uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-user-{i}") for i in range(10)]
EVENT_IDS = [uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-event-{i}") for i in range(31)]

SEED_PASSWORD = hash_password(os.environ["SEED_PASSWORD"])


# ---------------------------------------------------------------------------
# Organizer data
# ---------------------------------------------------------------------------

ORGANIZERS = [
    {
        "id": ORGANIZER_IDS[0],
        "name": "Sample Entertainment",
        "email": "organizer-a@example.com",
        "hashed_password": SEED_PASSWORD,
        "phone": "02-1234-5678",
        "is_verified": True,
        "is_organizer": True,
        "is_active": True,
        "verification_level": 2,
    },
    {
        "id": ORGANIZER_IDS[1],
        "name": "Test Corp",
        "email": "organizer-b@example.com",
        "hashed_password": SEED_PASSWORD,
        "phone": "02-2345-6789",
        "is_verified": True,
        "is_organizer": True,
        "is_active": True,
        "verification_level": 2,
    },
    {
        "id": ORGANIZER_IDS[2],
        "name": "Demo Events Inc.",
        "email": "organizer-c@example.com",
        "hashed_password": SEED_PASSWORD,
        "phone": "02-3456-7890",
        "is_verified": True,
        "is_organizer": True,
        "is_active": True,
        "verification_level": 2,
    },
]


# ---------------------------------------------------------------------------
# Regular user data
# ---------------------------------------------------------------------------

REGULAR_USERS = [
    {
        "name": "\uae40\ubbfc\uc900",
        "email": "minjun.kim@example.com",
        "phone": "010-1111-0001",
        "verification_level": 2,
    },
    {
        "name": "\uc774\uc11c\uc5f0",
        "email": "seoyeon.lee@example.com",
        "phone": "010-1111-0002",
        "verification_level": 2,
    },
    {
        "name": "\ubc15\uc9c0\ud6c8",
        "email": "jihoon.park@example.com",
        "phone": "010-1111-0003",
        "verification_level": 1,
    },
    {
        "name": "\ucd5c\uc218\uc544",
        "email": "sua.choi@example.com",
        "phone": "010-1111-0004",
        "verification_level": 2,
    },
    {
        "name": "\uc815\uc608\uc900",
        "email": "yejun.jung@example.com",
        "phone": "010-1111-0005",
        "verification_level": 1,
    },
    {
        "name": "\uac15\ud558\uc740",
        "email": "haeun.kang@example.com",
        "phone": "010-1111-0006",
        "verification_level": 2,
    },
    {
        "name": "\uc870\ub3c4\uc724",
        "email": "doyoon.cho@example.com",
        "phone": "010-1111-0007",
        "verification_level": 1,
    },
    {
        "name": "\uc724\uc9c0\uc6b0",
        "email": "jiwoo.yoon@example.com",
        "phone": "010-1111-0008",
        "verification_level": 2,
    },
    {
        "name": "\uc7a5\uc2dc\uc6b0",
        "email": "siwoo.jang@example.com",
        "phone": "010-1111-0009",
        "verification_level": 1,
    },
    {
        "name": "\ud55c\uc18c\ud76c",
        "email": "sohee.han@example.com",
        "phone": "010-1111-0010",
        "verification_level": 2,
    },
]

for idx, u in enumerate(REGULAR_USERS):
    u["id"] = USER_IDS[idx]
    u["hashed_password"] = SEED_PASSWORD
    u["is_verified"] = True
    u["is_organizer"] = False
    u["is_active"] = True


# ---------------------------------------------------------------------------
# Event data
# ---------------------------------------------------------------------------


def _bidding_open(hours_ago: int = 1, close_hours: int = 48):
    """Return (bidding_opens_at, bidding_closes_at) for already-open events."""
    return (NOW - timedelta(hours=hours_ago), NOW + timedelta(hours=close_hours))


def _bidding_future(open_days: int = 3, window_hours: int = 48):
    """Return (bidding_opens_at, bidding_closes_at) for opening-soon events."""
    opens = NOW + timedelta(days=open_days)
    return (opens, opens + timedelta(hours=window_hours))


def _event_date_weeks(weeks: int):
    """Return event_date N weeks from now."""
    return NOW + timedelta(weeks=weeks)


EVENTS = [
    # ---- CONCERTS (8) ----
    {
        "id": EVENT_IDS[0],
        "organizer_id": ORGANIZER_IDS[0],
        "title": 'Artist A \ucf58\uc11c\ud2b8 2026 "The Shining"',
        "description": "\uc778\uae30 \uc544\ud2f0\uc2a4\ud2b8 Artist A\uc758 2026\ub144 \uc804\uad6d \ud22c\uc5b4 \ucf58\uc11c\ud2b8. \uc815\uaddc 6\uc9d1 \uc218\ub85d\uace1\uacfc \ud788\ud2b8\uace1\uc744 \ub77c\uc774\ube0c\ub85c \ub9cc\ub098\ubcf4\uc138\uc694. \ud2b9\ubcc4\ud55c \ubb34\ub300 \uc5f0\ucd9c\uacfc \ud568\uaed8\ud558\ub294 \uc7a0\uc2e4 \ub2e8\ub3c5 \ucf58\uc11c\ud2b8!",
        "venue": "\uc62c\ub9bc\ud53d\uacf5\uc6d0 \uccb4\uc870\uacbd\uae30\uc7a5",
        "event_date": _event_date_weeks(4),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 15000,
        "min_price": 50000,
        "max_price": 200000,
        "category": "concert",
        "sub_category": "K-POP",
        "image_url": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Artist A (\uc544\ud2f0\uc2a4\ud2b8 A)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["Artist A", "K-POP", "\ucf58\uc11c\ud2b8", "\uc544\ud2f0\uc2a4\ud2b8A", "The Shining"]
        ),
        "is_featured": True,
        "bid_count": 2847,
        "view_count": 45230,
        "duration_minutes": 150,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[1],
        "organizer_id": ORGANIZER_IDS[0],
        "title": 'Star Group B \ud32c\ubbf8\ud305 "Here We Go"',
        "description": "Star Group B\uc758 \ud32c\ub4e4\uc744 \uc704\ud55c \ud2b9\ubcc4\ud55c \ud32c\ubbf8\ud305! \uba64\ubc84\ub4e4\uc758 \ud1a0\ud06c, \ubbf8\ub2c8 \ucf58\uc11c\ud2b8, \uac8c\uc784 \ub4f1 \ub2e4\uc591\ud55c \ucf58\ud150\uce20\uac00 \uc900\ube44\ub418\uc5b4 \uc788\uc2b5\ub2c8\ub2e4.",
        "venue": "\uc7a0\uc2e4\uc885\ud569\uc6b4\ub3d9\uc7a5",
        "event_date": _event_date_weeks(6),
        "bidding_opens_at": _bidding_open(2, 72)[0],
        "bidding_closes_at": _bidding_open(2, 72)[1],
        "total_seats": 40000,
        "min_price": 80000,
        "max_price": 300000,
        "category": "concert",
        "sub_category": "K-POP",
        "image_url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Star Group B (\uc2a4\ud0c0\uadf8\ub8f9 B)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["Star Group B", "\uc2a4\ud0c0\uadf8\ub8f9B", "K-POP", "\ud32c\ubbf8\ud305"]
        ),
        "is_featured": True,
        "bid_count": 1523,
        "view_count": 38900,
        "duration_minutes": 180,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[2],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "Group C WORLD TOUR 'SPARK' in BUSAN",
        "description": "Group C\uc758 \uccab \uc6d4\ub4dc\ud22c\uc5b4! \ud788\ud2b8\uace1 \ucd1d\ucd9c\ub3d9. \uba64\ubc84\ub4e4\uacfc \ud568\uaed8\ud558\ub294 \ud2b9\ubcc4\ud55c XR \ubb34\ub300.",
        "venue": "\ubd80\uc0b0 \ubca1\uc2a4\ucf54 \uc81c1\uc804\uc2dc\uc7a5",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(3, 36)[0],
        "bidding_closes_at": _bidding_open(3, 36)[1],
        "total_seats": 12000,
        "min_price": 60000,
        "max_price": 180000,
        "category": "concert",
        "sub_category": "K-POP",
        "image_url": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=400&q=80",
        "location_city": "\ubd80\uc0b0",
        "artist_name": "Group C (\uadf8\ub8f9 C)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["Group C", "\uadf8\ub8f9C", "K-POP", "\uc6d4\ub4dc\ud22c\uc5b4"]),
        "is_featured": False,
        "bid_count": 756,
        "view_count": 18500,
        "duration_minutes": 140,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[3],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "Band D \uc804\uad6d\ud22c\uc5b4 'FOREVER YOUNG'",
        "description": "Band D\uc758 \uc804\uad6d \ud22c\uc5b4! \ub77c\uc774\ube0c \ubc34\ub4dc\uc758 \uc9c4\uc815\ud55c \ub9e4\ub825\uc744 \ub290\ub084 \uc218 \uc788\ub294 \uacf5\uc5f0. \uba85\uace1 \ucd1d\ub9dd\ub77c.",
        "venue": "\ube14\ub8e8\uc2a4\ud018\uc5b4 \ucf58\uc11c\ud2b8\ud640",
        "event_date": _event_date_weeks(5),
        "bidding_opens_at": _bidding_open(1, 24)[0],
        "bidding_closes_at": _bidding_open(1, 24)[1],
        "total_seats": 2800,
        "min_price": 55000,
        "max_price": 110000,
        "category": "concert",
        "sub_category": "\ub85d/\ubc34\ub4dc",
        "image_url": "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Band D (\ubc34\ub4dc D)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["Band D", "\ubc34\ub4dcD", "\ubc34\ub4dc", "\ub77d"]),
        "is_featured": False,
        "bid_count": 432,
        "view_count": 9800,
        "duration_minutes": 130,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[4],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "Singer E \ucf58\uc11c\ud2b8 'SOUL TREE'",
        "description": "\ucd5c\uace0\uc758 \ubcf4\ucee4\ub9ac\uc2a4\ud2b8 Singer E\uc758 \ub2e8\ub3c5 \ucf58\uc11c\ud2b8. \uc138\uc885\ubb38\ud654\ud68c\uad00 \ub300\uadf9\uc7a5\uc5d0\uc11c \ud3bc\uccd0\uc9c0\ub294 \uac10\ub3d9\uc758 \ubb34\ub300.",
        "venue": "\uc138\uc885\ubb38\ud654\ud68c\uad00 \ub300\uadf9\uc7a5",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 3000,
        "min_price": 70000,
        "max_price": 250000,
        "category": "concert",
        "sub_category": "K-POP",
        "image_url": "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Singer E",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["Singer E", "\ubc1c\ub77c\ub4dc", "\ucf58\uc11c\ud2b8"]),
        "is_featured": False,
        "bid_count": 1891,
        "view_count": 25600,
        "duration_minutes": 150,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[5],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "Group F Fan Meeting 'So Nice'",
        "description": "Group F\uc758 \uccab \ub2e8\ub3c5 \ud32c\ubbf8\ud305! \uba64\ubc84\ub4e4\uacfc \ud568\uaed8\ud558\ub294 \ud1a0\ud06c, \ubbf8\ub2c8 \ub77c\uc774\ube0c, \ud32c \uc774\ubca4\ud2b8 \ub4f1 \ud2b9\ubcc4\ud55c \uc2dc\uac04\uc744 \ubcf4\ub0b4\uc138\uc694.",
        "venue": "\uc778\ucc9c \uc544\ub808\ub098",
        "event_date": _event_date_weeks(5),
        "bidding_opens_at": _bidding_open(1, 60)[0],
        "bidding_closes_at": _bidding_open(1, 60)[1],
        "total_seats": 20000,
        "min_price": 60000,
        "max_price": 200000,
        "category": "concert",
        "sub_category": "K-POP",
        "image_url": "https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=400&q=80",
        "location_city": "\uc778\ucc9c",
        "artist_name": "Group F (\uadf8\ub8f9 F)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["Group F", "\uadf8\ub8f9F", "K-POP", "\ud32c\ubbf8\ud305"]),
        "is_featured": True,
        "bid_count": 2103,
        "view_count": 41200,
        "duration_minutes": 160,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[6],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "World Band G 'Sounds of the Universe' Tour Korea",
        "description": "World Band G\uc758 \uc544\uc2dc\uc544 \ud22c\uc5b4 \ud55c\uad6d \uacf5\uc5f0! \uba85\uace1\uacfc \ud568\uaed8\ud558\ub294 \ud658\uc0c1\uc801\uc778 LED \ubb34\ub300.",
        "venue": "\uace0\ucc99 \uc2a4\uce74\uc774\ub3d4",
        "event_date": _event_date_weeks(8),
        "bidding_opens_at": _bidding_open(2, 48)[0],
        "bidding_closes_at": _bidding_open(2, 48)[1],
        "total_seats": 25000,
        "min_price": 90000,
        "max_price": 350000,
        "category": "concert",
        "sub_category": "\ud574\uc678\uc544\ud2f0\uc2a4\ud2b8",
        "image_url": "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "World Band G (\uc6d4\ub4dc\ubc34\ub4dc G)",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            [
                "World Band G",
                "\uc6d4\ub4dc\ubc34\ub4dcG",
                "\ud574\uc678\uc544\ud2f0\uc2a4\ud2b8",
                "\uc6d4\ub4dc\ud22c\uc5b4",
            ]
        ),
        "is_featured": False,
        "bid_count": 3421,
        "view_count": 50000,
        "duration_minutes": 150,
        "status": EventStatus.BIDDING_OPEN,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    {
        "id": EVENT_IDS[7],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "Singer H \uc804\uad6d\ud22c\uc5b4 '\uc990\uac70\uc6b4 \ub0a0'",
        "description": "Singer H\uc758 \uc804\uad6d \ud22c\uc5b4 \ucf58\uc11c\ud2b8! \ud788\ud2b8\uace1\uc744 \ub77c\uc774\ube0c\ub85c \uc990\uae30\uc138\uc694.",
        "venue": "\ub300\uad6c \uc5d1\uc2a4\ucf54",
        "event_date": _event_date_weeks(4),
        "bidding_opens_at": _bidding_future(5, 48)[0],
        "bidding_closes_at": _bidding_future(5, 48)[1],
        "total_seats": 5000,
        "min_price": 40000,
        "max_price": 90000,
        "category": "concert",
        "sub_category": "\uc778\ub514",
        "image_url": "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=400&q=80",
        "location_city": "\ub300\uad6c",
        "artist_name": "Singer H",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["Singer H", "\uc778\ub514", "\ud22c\uc5b4"]),
        "is_featured": False,
        "bid_count": 287,
        "view_count": 7200,
        "duration_minutes": 120,
        "status": EventStatus.DRAFT,
        "resale_enabled": True,
        "resale_max_markup_pct": 50.0,
        "resale_royalty_pct": 3.0,
        "resale_opens_at": NOW - timedelta(hours=24),
        "resale_closes_at": NOW + timedelta(days=30),
    },
    # ---- MUSICALS (5) ----
    {
        "id": EVENT_IDS[8],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "\ubba4\uc9c0\uceec \uc704\ud0a4\ub4dc (Wicked)",
        "description": "\ube0c\ub85c\ub4dc\uc6e8\uc774 \ub77c\uc774\uc120\uc2a4 \ubba4\uc9c0\uceec \uc704\ud0a4\ub4dc! \uc624\uc988\uc758 \ub9c8\ubc95\uc0ac\uc758 \uc228\uacac\uc9c4 \uc774\uc57c\uae30. Defying Gravity\ub97c \ub77c\uc774\ube0c\ub85c \uacbd\ud5d8\ud558\uc138\uc694.",
        "venue": "\ube14\ub8e8\uc2a4\ud018\uc5b4 \uacf5\uc5f0\ud640",
        "event_date": _event_date_weeks(2),
        "bidding_opens_at": _bidding_open(1, 36)[0],
        "bidding_closes_at": _bidding_open(1, 36)[1],
        "total_seats": 1500,
        "min_price": 60000,
        "max_price": 170000,
        "category": "musical",
        "sub_category": "\ub77c\uc774\uc120\uc2a4",
        "image_url": "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "8\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\ubba4\uc9c0\uceec",
                "\uc704\ud0a4\ub4dc",
                "\ube0c\ub85c\ub4dc\uc6e8\uc774",
                "\ub77c\uc774\uc120\uc2a4",
            ]
        ),
        "is_featured": False,
        "bid_count": 892,
        "view_count": 15600,
        "duration_minutes": 165,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[9],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "\uc624\ud398\ub77c\uc758 \uc720\ub839 (The Phantom of the Opera)",
        "description": "\uc804 \uc138\uacc4\ub97c \uc0ac\ub85c\uc7a1\uc740 \uc804\uc124\uc801\uc778 \ubba4\uc9c0\uceec! \ud30c\ub9ac \uc624\ud398\ub77c \uc9c0\ud558\uc758 \uc2e0\ube44\ub85c\uc6b4 \uc0ac\ub791 \uc774\uc57c\uae30.",
        "venue": "\uc0e4\ub86f\ub370\uc528\uc5b4\ud130",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 1800,
        "min_price": 70000,
        "max_price": 190000,
        "category": "musical",
        "sub_category": "\ub77c\uc774\uc120\uc2a4",
        "image_url": "https://images.unsplash.com/photo-1503095396549-807759245b35?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1503095396549-807759245b35?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "8\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\ubba4\uc9c0\uceec",
                "\uc624\ud398\ub77c\uc758\uc720\ub839",
                "\ube0c\ub85c\ub4dc\uc6e8\uc774",
            ]
        ),
        "is_featured": False,
        "bid_count": 645,
        "view_count": 12300,
        "duration_minutes": 155,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[10],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "\ubba4\uc9c0\uceec \uc2dc\uce74\uace0 (Chicago)",
        "description": "\uc7ac\uc988 \uc2dc\ub300\ub97c \ubc30\uacbd\uc73c\ub85c \ud55c \ud654\ub824\ud55c \ubba4\uc9c0\uceec! All That Jazz, Cell Block Tango \ub4f1 \uba85\uace1 \uac00\ub4dd.",
        "venue": "\ub514\ud050\ube0c\uc544\ud2b8\uc13c\ud130",
        "event_date": _event_date_weeks(4),
        "bidding_opens_at": _bidding_future(2, 48)[0],
        "bidding_closes_at": _bidding_future(2, 48)[1],
        "total_seats": 1200,
        "min_price": 50000,
        "max_price": 150000,
        "category": "musical",
        "sub_category": "\ub77c\uc774\uc120\uc2a4",
        "image_url": "https://images.unsplash.com/photo-1460723237483-7a6dc9d0b212?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1460723237483-7a6dc9d0b212?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "14\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\ubba4\uc9c0\uceec",
                "\uc2dc\uce74\uace0",
                "\uc7ac\uc988",
                "\ube0c\ub85c\ub4dc\uc6e8\uc774",
            ]
        ),
        "is_featured": False,
        "bid_count": 423,
        "view_count": 8900,
        "duration_minutes": 150,
        "status": EventStatus.DRAFT,
    },
    {
        "id": EVENT_IDS[11],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "\ucc3d\uc791\ubba4\uc9c0\uceec \uad11\ud654\ubb38\uc5f0\uac00",
        "description": "\uc800\uba85 \uc791\uace1\uac00\uc758 \uba85\uace1\uc744 \ubc14\ud0d5\uc73c\ub85c \ud55c \ud55c\uad6d \ub300\ud45c \ucc3d\uc791 \ubba4\uc9c0\uceec. \uc138\uc885\ubb38\ud654\ud68c\uad00\uc5d0\uc11c \ud3bc\uccd0\uc9c0\ub294 \uac10\ub3d9\uc758 \uc774\uc57c\uae30.",
        "venue": "\uc138\uc885\ubb38\ud654\ud68c\uad00 \ub300\uadf9\uc7a5",
        "event_date": _event_date_weeks(6),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 2000,
        "min_price": 40000,
        "max_price": 120000,
        "category": "musical",
        "sub_category": "\ucc3d\uc791",
        "image_url": "https://images.unsplash.com/photo-1585699324551-f6c309eedeca?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1585699324551-f6c309eedeca?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            [
                "\ucc3d\uc791\ubba4\uc9c0\uceec",
                "\uad11\ud654\ubb38\uc5f0\uac00",
                "\uc774\ubb38\uc138",
            ]
        ),
        "is_featured": False,
        "bid_count": 198,
        "view_count": 5400,
        "duration_minutes": 140,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[12],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "\uc5f0\uadf9 \ud584\ub9bf (Hamlet)",
        "description": "\uc170\uc775\uc2a4\ud53c\uc5b4 4\ub300 \ube44\uadf9 \uc911 \ud558\ub098\uc778 \ud584\ub9bf\uc744 \ud55c\uad6d \ucd5c\uace0\uc758 \ubc30\uc6b0\ub4e4\uc774 \ud3bc\ucce4\ub2e4. \uc608\uc220\uc758\uc804\ub2f9 \uc18c\uadf9\uc7a5\uc5d0\uc11c \ub9cc\ub098\ubcf4\uc138\uc694.",
        "venue": "\uc608\uc220\uc758\uc804\ub2f9 \uc18c\uadf9\uc7a5",
        "event_date": _event_date_weeks(2),
        "bidding_opens_at": _bidding_open(1, 24)[0],
        "bidding_closes_at": _bidding_open(1, 24)[1],
        "total_seats": 1000,
        "min_price": 30000,
        "max_price": 80000,
        "category": "musical",
        "sub_category": "\uc5f0\uadf9",
        "image_url": "https://images.unsplash.com/photo-1574391884720-bbc3740c59d1?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1574391884720-bbc3740c59d1?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "14\uc138 \uc774\uc0c1",
        "tags": json.dumps(["\uc5f0\uadf9", "\ud584\ub9bf", "\uc170\uc775\uc2a4\ud53c\uc5b4"]),
        "is_featured": False,
        "bid_count": 156,
        "view_count": 3200,
        "duration_minutes": 180,
        "status": EventStatus.BIDDING_OPEN,
    },
    # ---- SPORTS (4) ----
    {
        "id": EVENT_IDS[13],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "2026 KBO \ud55c\uad6d\uc2dc\ub9ac\uc988",
        "description": "2026 KBO \ud55c\uad6d\uc2dc\ub9ac\uc988! \ud55c\uad6d \ud504\ub85c\uc57c\uad6c \ucd5c\uace0\uc758 \uc21c\uac04\uc744 \uc7a0\uc2e4\uc57c\uad6c\uc7a5\uc5d0\uc11c \ud568\uaed8\ud558\uc138\uc694.",
        "venue": "\uc7a0\uc2e4\uc57c\uad6c\uc7a5",
        "event_date": _event_date_weeks(7),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 25000,
        "min_price": 30000,
        "max_price": 150000,
        "category": "sports",
        "sub_category": "\uc57c\uad6c",
        "image_url": "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1546519638-68e109498ffc?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["KBO", "\uc57c\uad6c", "\ud55c\uad6d\uc2dc\ub9ac\uc988", "\uc7a0\uc2e4"]
        ),
        "is_featured": True,
        "bid_count": 1245,
        "view_count": 28700,
        "duration_minutes": 210,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[14],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "2026 K\ub9ac\uadf8 FA\ucef5 \uacb0\uc2b9",
        "description": "K\ub9ac\uadf8 FA\ucef5 \uacb0\uc2b9\uc804! \ud55c\uad6d \ucd95\uad6c\uc758 \ub728\uac70\uc6b4 \ud568\uc131\uc744 \uc11c\uc6b8\uc6d4\ub4dc\ucef5\uacbd\uae30\uc7a5\uc5d0\uc11c \ub290\uaef4\ubcf4\uc138\uc694.",
        "venue": "\uc11c\uc6b8\uc6d4\ub4dc\ucef5\uacbd\uae30\uc7a5",
        "event_date": _event_date_weeks(5),
        "bidding_opens_at": _bidding_open(1, 36)[0],
        "bidding_closes_at": _bidding_open(1, 36)[1],
        "total_seats": 40000,
        "min_price": 20000,
        "max_price": 80000,
        "category": "sports",
        "sub_category": "\ucd95\uad6c",
        "image_url": "https://images.unsplash.com/photo-1461896836934-bd45ba5b5024?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1461896836934-bd45ba5b5024?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(["K\ub9ac\uadf8", "FA\ucef5", "\ucd95\uad6c", "\uacb0\uc2b9"]),
        "is_featured": False,
        "bid_count": 876,
        "view_count": 19400,
        "duration_minutes": 120,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[15],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "Team Alpha vs Team Beta \u2014 \ud504\ub85c\ub9ac\uadf8 \uacb0\uc2b9\uc804",
        "description": "\ud504\ub85c\ub9ac\uadf8 \ucd5c\uace0\uc758 \ub77c\uc774\ubc8c\ub9ac \ub9e4\uce58\ub97c e\uc2a4\ud3ec\uce20 \uc544\ub808\ub098\uc5d0\uc11c \uc9c1\uad00\ud558\uc138\uc694. \uc5ed\ub300\uae09 e\uc2a4\ud3ec\uce20 \uc774\ubca4\ud2b8!",
        "venue": "e\uc2a4\ud3ec\uce20 \uc544\ub808\ub098",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(1, 24)[0],
        "bidding_closes_at": _bidding_open(1, 24)[1],
        "total_seats": 500,
        "min_price": 30000,
        "max_price": 90000,
        "category": "sports",
        "sub_category": "e\uc2a4\ud3ec\uce20",
        "image_url": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["Team Alpha", "Team Beta", "\ud504\ub85c\ub9ac\uadf8", "e\uc2a4\ud3ec\uce20", "\uacb0\uc2b9\uc804"]
        ),
        "is_featured": False,
        "bid_count": 2156,
        "view_count": 35800,
        "duration_minutes": 300,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[16],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "\uaca9\ud22c\uae30 \ucc54\ud53c\uc5b8\uc2ed \uc11c\uc6b8",
        "description": "\uaca9\ud22c\uae30 \ucc54\ud53c\uc5b8\uc2ed\uc774 \uc11c\uc6b8\uc5d0 \ub3cc\uc544\uc628\ub2e4! \uc138\uacc4 \ucd5c\uace0\uc758 MMA \ud30c\uc774\ud130\ub4e4\uc758 \uc5f4\uc815\uc801\uc778 \uacbd\uae30\ub97c \uace0\ucc99 \uc2a4\uce74\uc774\ub3d4\uc5d0\uc11c!",
        "venue": "\uace0\ucc99 \uc2a4\uce74\uc774\ub3d4",
        "event_date": _event_date_weeks(6),
        "bidding_opens_at": _bidding_future(7, 48)[0],
        "bidding_closes_at": _bidding_future(7, 48)[1],
        "total_seats": 15000,
        "min_price": 50000,
        "max_price": 300000,
        "category": "sports",
        "sub_category": "\uaca9\ud22c\uae30",
        "image_url": "https://images.unsplash.com/photo-1587280501635-68a0e82cd5ff?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1587280501635-68a0e82cd5ff?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "15\uc138 \uc774\uc0c1",
        "tags": json.dumps(["\uaca9\ud22c\uae30", "\ucc54\ud53c\uc5b8\uc2ed", "MMA"]),
        "is_featured": False,
        "bid_count": 934,
        "view_count": 22100,
        "duration_minutes": 240,
        "status": EventStatus.DRAFT,
    },
    # ---- CLASSICAL (3) ----
    {
        "id": EVENT_IDS[17],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "\uc11c\uc6b8\uc2dc\ud5a5 2026 \uc2e0\ub144\uc74c\uc545\ud68c",
        "description": "Sample Symphony Orchestra\uc758 \uc2e0\ub144 \ud2b9\ubcc4 \uacf5\uc5f0. \ubca0\ud1a0\ubca4, \ucc28\uc774\ucf54\ud504\uc2a4\ud0a4 \ub4f1 \ud074\ub798\uc2dd \uba85\uace1\uc744 \uc608\uc220\uc758\uc804\ub2f9\uc5d0\uc11c \uc990\uae30\uc138\uc694.",
        "venue": "\uc608\uc220\uc758\uc804\ub2f9 \ucf58\uc11c\ud2b8\ud640",
        "event_date": _event_date_weeks(2),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 2500,
        "min_price": 30000,
        "max_price": 120000,
        "category": "classical",
        "sub_category": "\uc624\ucf00\uc2a4\ud2b8\ub77c",
        "image_url": "https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Sample Symphony Orchestra",
        "age_restriction": "8\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\ud074\ub798\uc2dd",
                "\uc624\ucf00\uc2a4\ud2b8\ub77c",
                "\uc2dc\ud5a5",
                "\uc2e0\ub144\uc74c\uc545\ud68c",
            ]
        ),
        "is_featured": False,
        "bid_count": 234,
        "view_count": 6700,
        "duration_minutes": 120,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[18],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "Pianist J \ud53c\uc544\ub178 \ub9ac\uc0ac\uc774\ud2c0",
        "description": "\uc138\uacc4\uc801 \ud53c\uc544\ub2c8\uc2a4\ud2b8 Pianist J\uc758 \uadc0\uad6d \ub9ac\uc0ac\uc774\ud2c0. \uc1fc\ud321, \ub77c\ud750\ub9c8\ub2c8\ub178\ud504, \ub4dc\ubdd4\uc2dc \ub4f1 \ub9c8\uc2a4\ud130\ud53c\uc2a4 \uc5f0\uc8fc.",
        "venue": "\ucf58\uc11c\ud2b8\ud640",
        "event_date": _event_date_weeks(4),
        "bidding_opens_at": _bidding_open(1, 60)[0],
        "bidding_closes_at": _bidding_open(1, 60)[1],
        "total_seats": 2000,
        "min_price": 50000,
        "max_price": 180000,
        "category": "classical",
        "sub_category": "\ub3c5\uc8fc\ud68c",
        "image_url": "https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Pianist J",
        "age_restriction": "8\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\uc870\uc131\uc9c4",
                "\ud53c\uc544\ub178",
                "\ub9ac\uc0ac\uc774\ud2c0",
                "\ud074\ub798\uc2dd",
            ]
        ),
        "is_featured": False,
        "bid_count": 567,
        "view_count": 14200,
        "duration_minutes": 100,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[19],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "Sample Philharmonic \ub0b4\ud55c\uacf5\uc5f0",
        "description": "\uc138\uacc4 \ucd5c\uace0\uc758 \uc624\ucf00\uc2a4\ud2b8\ub77c, Sample Philharmonic\uc758 \ud55c\uad6d \ub0b4\ud55c\uacf5\uc5f0. \ub9d0\ub7ec, \ube0c\ub8e8\ud06c\ub108, \ubca0\ud1a0\ubca4 \ud504\ub85c\uadf8\ub7a8.",
        "venue": "\uc608\uc220\uc758\uc804\ub2f9 \ucf58\uc11c\ud2b8\ud640",
        "event_date": _event_date_weeks(8),
        "bidding_opens_at": _bidding_future(10, 72)[0],
        "bidding_closes_at": _bidding_future(10, 72)[1],
        "total_seats": 2500,
        "min_price": 80000,
        "max_price": 300000,
        "category": "classical",
        "sub_category": "\uc624\ucf00\uc2a4\ud2b8\ub77c",
        "image_url": "https://images.unsplash.com/photo-1514119412350-e174d90d585e?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1514119412350-e174d90d585e?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Sample Philharmonic",
        "age_restriction": "8\uc138 \uc774\uc0c1",
        "tags": json.dumps(
            [
                "\ube48\ud544\ud558\ubaa8\ub2c9",
                "\uc624\ucf00\uc2a4\ud2b8\ub77c",
                "\ud074\ub798\uc2dd",
                "\ub0b4\ud55c\uacf5\uc5f0",
            ]
        ),
        "is_featured": False,
        "bid_count": 789,
        "view_count": 17800,
        "duration_minutes": 130,
        "status": EventStatus.DRAFT,
    },
    # ---- EXHIBITION (3) ----
    {
        "id": EVENT_IDS[20],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "Digital Art Lab X \uc11c\uc6b8",
        "description": "\ub514\uc9c0\ud138 \uc544\ud2b8 \uadf8\ub8f9 Lab X\uc758 \uc11c\uc6b8 \uc0c1\uc124 \uc804\uc2dc. \ube5b\uacfc \uc18c\ub9ac\ub85c \ucc3d\uc870\ub418\ub294 \ubab0\uc785\ud615 \ub514\uc9c0\ud138 \uc544\ud2b8 \uccb4\ud5d8.",
        "venue": "DDP (\ub3d9\ub300\ubb38\ub514\uc790\uc778\ud50c\ub77c\uc790)",
        "event_date": _event_date_weeks(2),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 3000,
        "min_price": 25000,
        "max_price": 45000,
        "category": "exhibition",
        "sub_category": "\uccb4\ud5d8\uc804",
        "image_url": "https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1544967082-d9d25d867d66?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Digital Art Lab X",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["Lab X", "\ub514\uc9c0\ud138\uc544\ud2b8", "\uccb4\ud5d8\uc804", "\ubab0\uc785\ud615"]
        ),
        "is_featured": False,
        "bid_count": 1567,
        "view_count": 32100,
        "duration_minutes": 90,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[21],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "Painter M: \uc778\uc0c1\uc8fc\uc758 \ud2b9\ubcc4\uc804",
        "description": "Painter M\uc758 \uc778\uc0c1\uc8fc\uc758 \uac78\uc791\uc744 \ud55c\uc790\ub9ac\uc5d0\uc11c \uac10\uc0c1\ud558\ub294 \ud2b9\ubcc4\uc804. \uc218\ub828, \uac74\ucd08\ub354\ubbf8, \uc778\uc0c1 \ub4f1 \uc8fc\uc694 \uc791\ud488 \uc804\uc2dc.",
        "venue": "\uc608\uc220\uc758\uc804\ub2f9 \ud55c\uac00\ub78c\ubbf8\uc220\uad00",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(1, 36)[0],
        "bidding_closes_at": _bidding_open(1, 36)[1],
        "total_seats": 2000,
        "min_price": 20000,
        "max_price": 35000,
        "category": "exhibition",
        "sub_category": "\ubbf8\uc220",
        "image_url": "https://images.unsplash.com/photo-1531243269054-5ebf6f34081e?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1531243269054-5ebf6f34081e?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": "Painter M",
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            [
                "\ubaa8\ub124",
                "\uc778\uc0c1\uc8fc\uc758",
                "\ubbf8\uc220\uc804\uc2dc",
                "\ud2b9\ubcc4\uc804",
            ]
        ),
        "is_featured": False,
        "bid_count": 345,
        "view_count": 8900,
        "duration_minutes": 60,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[22],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "Animation Studio 100\uc8fc\ub144 \ud2b9\ubcc4\uc804",
        "description": "Animation Studio 100\uc8fc\ub144\uc744 \uae30\ub150\ud558\ub294 \ub300\uaddc\ubaa8 \ud2b9\ubcc4\uc804! \ub300\ud45c \uce90\ub9ad\ud130\ubd80\ud130 \ucd5c\uc2e0 \uc791\ud488\uae4c\uc9c0 \ubaa8\ub4e0 \uac83\uc744 \uccb4\ud5d8\ud558\uc138\uc694.",
        "venue": "\ucf54\uc5d1\uc2a4 \uc804\uc2dc\ud640",
        "event_date": _event_date_weeks(4),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 5000,
        "min_price": 18000,
        "max_price": 30000,
        "category": "exhibition",
        "sub_category": "\uccb4\ud5d8\uc804",
        "image_url": "https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["Animation Studio", "100\uc8fc\ub144", "\uccb4\ud5d8\uc804", "\ucf54\uc5d1\uc2a4"]
        ),
        "is_featured": False,
        "bid_count": 678,
        "view_count": 14500,
        "duration_minutes": 90,
        "status": EventStatus.BIDDING_OPEN,
    },
    # ---- FESTIVALS (3) ----
    {
        "id": EVENT_IDS[23],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "2026 \uc790\ub77c\uc12c \uc7ac\uc988\ud398\uc2a4\ud2f0\ubc8c",
        "description": "\uad6d\ub0b4 \ucd5c\ub300 \uc7ac\uc988 \ud398\uc2a4\ud2f0\ubc8c! \uad6d\ub0b4\uc678 \uc815\uc0c1\uae09 \uc7ac\uc988 \uc544\ud2f0\uc2a4\ud2b8\ub4e4\uc758 \uacf5\uc5f0\uc744 \uc790\ub77c\uc12c\uc758 \uc790\uc5f0 \uc18d\uc5d0\uc11c \uc990\uae30\uc138\uc694.",
        "venue": "\uac00\ud3c9 \uc790\ub77c\uc12c",
        "event_date": _event_date_weeks(6),
        "bidding_opens_at": _bidding_open(1, 72)[0],
        "bidding_closes_at": _bidding_open(1, 72)[1],
        "total_seats": 30000,
        "min_price": 80000,
        "max_price": 150000,
        "category": "festival",
        "sub_category": "\uc74c\uc545\ucd95\uc81c",
        "image_url": "https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=400&q=80",
        "location_city": "\uacbd\uae30",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            [
                "\uc790\ub77c\uc12c",
                "\uc7ac\uc988",
                "\ud398\uc2a4\ud2f0\ubc8c",
                "\uc74c\uc545\ucd95\uc81c",
            ]
        ),
        "is_featured": False,
        "bid_count": 1234,
        "view_count": 26800,
        "duration_minutes": 720,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[24],
        "organizer_id": ORGANIZER_IDS[0],
        "title": "EDM Fest Korea 2026",
        "description": "\uc138\uacc4 \ucd5c\ub300 EDM \ud398\uc2a4\ud2f0\ubc8c\uc758 \ud55c\uad6d \ubc84\uc804! \uc138\uacc4\uc801 DJ \ucd1d\ucd9c\ub3d9.",
        "venue": "\uc7a0\uc2e4\uc885\ud569\uc6b4\ub3d9\uc7a5 \ubcf4\uc870\uacbd\uae30\uc7a5",
        "event_date": _event_date_weeks(7),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 50000,
        "min_price": 120000,
        "max_price": 250000,
        "category": "festival",
        "sub_category": "\uc74c\uc545\ucd95\uc81c",
        "image_url": "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "19\uc138 \uc774\uc0c1",
        "tags": json.dumps(["EDM Fest", "EDM", "\ud398\uc2a4\ud2f0\ubc8c", "\uc74c\uc545"]),
        "is_featured": True,
        "bid_count": 2890,
        "view_count": 47600,
        "duration_minutes": 720,
        "status": EventStatus.BIDDING_OPEN,
    },
    {
        "id": EVENT_IDS[25],
        "organizer_id": ORGANIZER_IDS[1],
        "title": "2026 \uc11c\uc6b8 \ube5b\ucd08\ub871 \ucd95\uc81c",
        "description": "\uccad\uacc4\ucc9c \uc77c\ub300\ub97c \uc218\ub193\ub294 \uc544\ub984\ub2e4\uc6b4 \ub4f1\ubd88 \ucd95\uc81c. \uc804\ud1b5\uacfc \ud604\ub300\uac00 \uc5b4\uc6b0\ub7ec\uc9c0\ub294 \ube5b\uc758 \ud5a5\uc5f0\uc744 \uc990\uae30\uc138\uc694. (\ubb34\ub8cc \uad6c\uac04 \ud3ec\ud568)",
        "venue": "\uccad\uacc4\ucc9c \uc77c\ub300",
        "event_date": _event_date_weeks(3),
        "bidding_opens_at": _bidding_open(1, 48)[0],
        "bidding_closes_at": _bidding_open(1, 48)[1],
        "total_seats": 100000,
        "min_price": 0,
        "max_price": 15000,
        "category": "festival",
        "sub_category": "\uacc4\uc808\ud589\uc0ac",
        "image_url": "https://images.unsplash.com/photo-1472653431158-6364773b2a56?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1472653431158-6364773b2a56?w=400&q=80",
        "location_city": "\uc11c\uc6b8",
        "artist_name": None,
        "age_restriction": "\uc804\uccb4\uad00\ub78c\uac00",
        "tags": json.dumps(
            ["\ube5b\ucd08\ub871", "\ucd95\uc81c", "\uccad\uacc4\ucc9c", "\uc11c\uc6b8"]
        ),
        "is_featured": False,
        "bid_count": 456,
        "view_count": 11200,
        "duration_minutes": 180,
        "status": EventStatus.BIDDING_OPEN,
    },
    # ---- PUBLIC SECTOR EVENTS (5) ----
    {
        "id": EVENT_IDS[26],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "2026 얼음나라 화천 산천어축제",
        "description": "CNN 선정 '겨울의 7대 불가사의'. 얼음낚시, 맨손잡기, 얼음썰매 등 대한민국 대표 겨울축제.",
        "venue": "화천군 화천읍 산천어길 일원",
        "event_date": _event_date_weeks(2),
        "bidding_opens_at": _bidding_open(2, 48)[0],
        "bidding_closes_at": _bidding_open(2, 48)[1],
        "total_seats": 50000,
        "min_price": 0,
        "max_price": 5000,
        "category": "festival",
        "sub_category": "시민 축제",
        "image_url": "https://images.unsplash.com/photo-1516912938509-1fee231102aa?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1516912938509-1fee231102aa?w=400&q=80",
        "location_city": "강원",
        "age_restriction": "전체관람가",
        "tags": json.dumps(["겨울축제", "얼음낚시", "가족", "체험"]),
        "is_featured": True,
        "bid_count": 38420,
        "view_count": 215000,
        "duration_minutes": 480,
        "status": EventStatus.BIDDING_OPEN,
        "is_public_sector": True,
        "is_free": False,
        "deposit_amount": 5000,
    },
    {
        "id": EVENT_IDS[27],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "제64회 진해 군항제",
        "description": "대한민국 최대 벚꽃축제. 이충무공 추모대제, 승전행차 퍼레이드, 팔도풍물시장.",
        "venue": "창원시 진해구 중원로터리 일대",
        "event_date": _event_date_weeks(5),
        "bidding_opens_at": _bidding_future(3, 48)[0],
        "bidding_closes_at": _bidding_future(3, 48)[1],
        "total_seats": 100000,
        "min_price": 0,
        "max_price": 0,
        "category": "festival",
        "sub_category": "시민 축제",
        "image_url": "https://images.unsplash.com/photo-1522383225653-ed111181a951?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1522383225653-ed111181a951?w=400&q=80",
        "location_city": "경상",
        "age_restriction": "전체관람가",
        "tags": json.dumps(["벚꽃", "군항제", "진해", "봄"]),
        "is_featured": True,
        "bid_count": 0,
        "view_count": 420000,
        "duration_minutes": 600,
        "status": EventStatus.DRAFT,
        "is_public_sector": True,
        "is_free": True,
    },
    {
        "id": EVENT_IDS[28],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "제18회 고양 국제꽃박람회",
        "description": "'꽃, 시간을 물들이다' — 국내 최대 화훼 박람회. 대형 주제정원, K-플라워 가든.",
        "venue": "고양시 일산호수공원",
        "event_date": _event_date_weeks(7),
        "bidding_opens_at": _bidding_future(5, 48)[0],
        "bidding_closes_at": _bidding_future(5, 48)[1],
        "total_seats": 50000,
        "min_price": 12000,
        "max_price": 15000,
        "category": "exhibition",
        "sub_category": "전시",
        "image_url": "https://images.unsplash.com/photo-1615046526364-ccfd92cd45bd?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1615046526364-ccfd92cd45bd?w=400&q=80",
        "location_city": "경기",
        "age_restriction": "전체관람가",
        "tags": json.dumps(["꽃박람회", "정원", "전시", "봄"]),
        "is_featured": True,
        "bid_count": 0,
        "view_count": 195000,
        "duration_minutes": 480,
        "status": EventStatus.DRAFT,
        "is_public_sector": True,
        "is_free": False,
    },
    {
        "id": EVENT_IDS[29],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "강릉 단오제",
        "description": "UNESCO 인류무형문화유산. 단오굿, 관노가면극, 씨름, 그네타기 등 전통 세시풍속.",
        "venue": "강릉시 남대천 일대",
        "event_date": _event_date_weeks(10),
        "bidding_opens_at": _bidding_future(7, 48)[0],
        "bidding_closes_at": _bidding_future(7, 48)[1],
        "total_seats": 45000,
        "min_price": 0,
        "max_price": 0,
        "category": "classical",
        "sub_category": "문화 공연",
        "image_url": "https://images.unsplash.com/photo-1601900245655-7719650f5b7a?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1601900245655-7719650f5b7a?w=400&q=80",
        "location_city": "강원",
        "age_restriction": "전체관람가",
        "tags": json.dumps(["UNESCO", "단오", "전통", "강릉"]),
        "is_featured": True,
        "bid_count": 0,
        "view_count": 185000,
        "duration_minutes": 600,
        "status": EventStatus.DRAFT,
        "is_public_sector": True,
        "is_free": True,
    },
    {
        "id": EVENT_IDS[30],
        "organizer_id": ORGANIZER_IDS[2],
        "title": "2026 서울 러너스 페스티벌",
        "description": "서울 도심을 달리는 시민 참여형 러닝 축제. 5K, 10K 코스.",
        "venue": "서울 도심 코스 (광화문 출발)",
        "event_date": _event_date_weeks(8),
        "bidding_opens_at": _bidding_future(4, 48)[0],
        "bidding_closes_at": _bidding_future(4, 48)[1],
        "total_seats": 40000,
        "min_price": 30000,
        "max_price": 50000,
        "category": "sports",
        "sub_category": "체육 행사",
        "image_url": "https://images.unsplash.com/photo-1730045768278-bb87a2939e71?w=800&q=80",
        "thumbnail_url": "https://images.unsplash.com/photo-1730045768278-bb87a2939e71?w=400&q=80",
        "location_city": "서울",
        "age_restriction": "전체관람가",
        "tags": json.dumps(["러닝", "마라톤", "시민", "서울"]),
        "is_featured": False,
        "bid_count": 0,
        "view_count": 128000,
        "duration_minutes": 300,
        "status": EventStatus.DRAFT,
        "is_public_sector": True,
        "is_free": False,
    },
]


# ---------------------------------------------------------------------------
# Top-10 popular events (by bid_count) for bid generation
# ---------------------------------------------------------------------------

# Sort by bid_count descending, pick top 10
TOP_EVENT_INDICES = sorted(range(len(EVENTS)), key=lambda i: EVENTS[i]["bid_count"], reverse=True)[
    :10
]


# ---------------------------------------------------------------------------
# Resale-enabled event indices (top 8 = concerts)
# ---------------------------------------------------------------------------

RESALE_EVENT_INDICES = list(range(8))  # EVENT_IDS[0] through EVENT_IDS[7]

# Tier definitions for resale-enabled events
TIER_DEFS = [
    {"name": "VIP\uc11d", "capacity": 500, "price_fn": lambda evt: evt["max_price"]},
    {"name": "R\uc11d", "capacity": 2000, "price_fn": lambda evt: evt["min_price"] * 1.5},
    {"name": "S\uc11d", "capacity": 3000, "price_fn": lambda evt: evt["min_price"]},
]

# Pre-compute deterministic tier IDs and store mapping
TIER_IDS = {}  # (event_idx, tier_name) -> uuid
ALL_TIER_IDS_LIST = []
for _ei in RESALE_EVENT_INDICES:
    for _ti, _td in enumerate(TIER_DEFS):
        _tier_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-tier-{_ei}-{_ti}")
        TIER_IDS[(_ei, _td["name"])] = _tier_id
        ALL_TIER_IDS_LIST.append(_tier_id)

# Pre-compute deterministic ticket IDs
# 10 tickets per resale-enabled event = 80 total
TICKETS_PER_EVENT = 10
ALL_TICKET_IDS = []
TICKET_IDS_BY_EVENT = {}  # event_idx -> list of ticket uuids
for _ei in RESALE_EVENT_INDICES:
    _tids = []
    for _ti in range(TICKETS_PER_EVENT):
        _tid = uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-ticket-{_ei}-{_ti}")
        _tids.append(_tid)
        ALL_TICKET_IDS.append(_tid)
    TICKET_IDS_BY_EVENT[_ei] = _tids


# ---------------------------------------------------------------------------
# Main seed function
# ---------------------------------------------------------------------------


async def seed():
    print("=" * 60)
    print("  Pickket Seed Data Script")
    print("=" * 60)
    print()

    db_url = settings.DATABASE_URL
    print(f"Database: {db_url}")
    print()

    engine = create_async_engine(db_url, echo=False)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # 1. Create all tables
    print("[1/8] Creating tables (if not exist)...")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("       Tables ready.")

    async with session_factory() as session:
        async with session.begin():
            # 2. Clear existing seed data (idempotent)
            print("[2/8] Clearing existing seed data...")
            all_seed_user_ids = ORGANIZER_IDS + USER_IDS

            # --- Resale data cleanup (must come before tickets/tiers/events) ---
            # Delete ownership transfers for seed tickets
            await session.execute(
                delete(OwnershipTransfer).where(OwnershipTransfer.ticket_id.in_(ALL_TICKET_IDS))
            )
            # Delete resale listings for seed tickets
            await session.execute(
                delete(ResaleListingModel).where(ResaleListingModel.ticket_id.in_(ALL_TICKET_IDS))
            )
            # Delete resale buy orders for seed events
            await session.execute(
                delete(ResaleBuyOrderModel).where(ResaleBuyOrderModel.event_id.in_(EVENT_IDS))
            )
            # Delete tickets for seed events
            await session.execute(delete(Ticket).where(Ticket.event_id.in_(EVENT_IDS)))

            # --- Original cleanup ---
            # Delete bids by seed users first (FK constraint)
            await session.execute(delete(Bid).where(Bid.user_id.in_(all_seed_user_ids)))
            # Delete bids on seed events
            await session.execute(delete(Bid).where(Bid.event_id.in_(EVENT_IDS)))
            # Delete allocation results for seed events
            alloc_result = await session.execute(
                select(Allocation.id).where(Allocation.event_id.in_(EVENT_IDS))
            )
            alloc_ids = [row[0] for row in alloc_result.all()]
            if alloc_ids:
                await session.execute(
                    delete(AllocationResult).where(AllocationResult.allocation_id.in_(alloc_ids))
                )
                await session.execute(delete(Allocation).where(Allocation.id.in_(alloc_ids)))
            # Delete seat tiers for seed events
            await session.execute(delete(SeatTier).where(SeatTier.event_id.in_(EVENT_IDS)))
            # Delete interactions by seed users
            await session.execute(
                delete(UserInteraction).where(UserInteraction.user_id.in_(all_seed_user_ids))
            )
            # Delete seed events
            await session.execute(delete(Event).where(Event.id.in_(EVENT_IDS)))
            # Delete seed users
            await session.execute(delete(User).where(User.id.in_(all_seed_user_ids)))

            print("       Cleared.")

            # 3. Create users
            print("[3/8] Creating users...")

            organizer_count = 0
            for org_data in ORGANIZERS:
                user = User(**org_data)
                session.add(user)
                organizer_count += 1

            user_count = 0
            for user_data in REGULAR_USERS:
                user = User(**user_data)
                session.add(user)
                user_count += 1

            await session.flush()
            print(f"       Created {organizer_count} organizers + {user_count} regular users.")

            # 4. Create events
            print("[4/8] Creating events...")

            event_count = 0
            for evt_data in EVENTS:
                event = Event(**evt_data)
                session.add(event)
                event_count += 1

            await session.flush()
            print(f"       Created {event_count} events.")

            # 4.5. Create venues and link to events
            print("[4.5/8] Creating venues...")

            # 공연장별 섹션 SVG path (실제 배치도 느낌)
            VENUE_TEMPLATES = {
                "콘서트홀": {
                    "name": "KSPO DOME",
                    "city": "서울",
                    "address": "서울시 송파구 올림픽로 424",
                    "capacity": 15000,
                    "width": 1000,
                    "height": 800,
                    "sections": [
                        {
                            "name": "VIP석", "label": "VIP", "capacity": 50,
                            "svg_path": "M350,150 L650,150 L650,300 L350,300 Z",
                            "center_x": 500, "center_y": 225, "floor": 1, "color": "#8B5CF6",
                        },
                        {
                            "name": "R석", "label": "R", "capacity": 120,
                            "svg_path": "M200,320 L800,320 L800,500 L200,500 Z",
                            "center_x": 500, "center_y": 410, "floor": 1, "color": "#3B82F6",
                        },
                        {
                            "name": "S석", "label": "S", "capacity": 200,
                            "svg_path": "M100,520 L900,520 L900,700 L100,700 Z",
                            "center_x": 500, "center_y": 610, "floor": 1, "color": "#10B981",
                        },
                    ],
                },
                "야구장": {
                    "name": "사직야구장",
                    "city": "부산",
                    "address": "부산시 동래구 사직로 45",
                    "capacity": 24000,
                    "width": 1000,
                    "height": 800,
                    "sections": [
                        {
                            "name": "VIP석", "label": "VIP", "capacity": 50,
                            "svg_path": "M400,400 L600,400 L600,500 L400,500 Z",
                            "center_x": 500, "center_y": 450, "floor": 1, "color": "#8B5CF6",
                        },
                        {
                            "name": "1루석", "label": "1루", "capacity": 100,
                            "svg_path": "M620,300 L850,300 L900,550 L650,500 Z",
                            "center_x": 760, "center_y": 410, "floor": 1, "color": "#3B82F6",
                        },
                        {
                            "name": "3루석", "label": "3루", "capacity": 100,
                            "svg_path": "M150,300 L380,300 L350,500 L100,550 Z",
                            "center_x": 240, "center_y": 410, "floor": 1, "color": "#10B981",
                        },
                        {
                            "name": "외야석", "label": "외야", "capacity": 200,
                            "svg_path": "M150,100 L850,100 L900,280 L100,280 Z",
                            "center_x": 500, "center_y": 190, "floor": 1, "color": "#F59E0B",
                        },
                    ],
                },
                "기본": {
                    "name": "공연장",
                    "city": "서울",
                    "address": "",
                    "capacity": 5000,
                    "width": 1000,
                    "height": 800,
                    "sections": [
                        {
                            "name": "A석", "label": "A", "capacity": 100,
                            "svg_path": "M250,200 L750,200 L750,400 L250,400 Z",
                            "center_x": 500, "center_y": 300, "floor": 1, "color": "#3B82F6",
                        },
                        {
                            "name": "B석", "label": "B", "capacity": 150,
                            "svg_path": "M150,420 L850,420 L850,650 L150,650 Z",
                            "center_x": 500, "center_y": 535, "floor": 1, "color": "#10B981",
                        },
                    ],
                },
            }

            venue_count = 0
            for evt_data in EVENTS:
                event_id = evt_data["id"]
                cat = evt_data.get("category", "concert")

                # 카테고리별 venue 템플릿 선택
                if cat == "sports":
                    tmpl = VENUE_TEMPLATES["야구장"]
                elif cat in ("concert", "musical", "classical"):
                    tmpl = VENUE_TEMPLATES["콘서트홀"]
                else:
                    tmpl = VENUE_TEMPLATES["기본"]

                venue_id = uuid.uuid5(uuid.NAMESPACE_DNS, f"venue-{event_id}")
                venue = Venue(
                    id=venue_id,
                    name=evt_data.get("venue", tmpl["name"]),
                    city=evt_data.get("location_city", tmpl["city"]),
                    address=tmpl["address"],
                    total_capacity=tmpl["capacity"],
                    map_width=tmpl["width"],
                    map_height=tmpl["height"],
                )
                session.add(venue)

                for sec_def in tmpl["sections"]:
                    section = VenueSection(
                        id=uuid.uuid5(uuid.NAMESPACE_DNS, f"section-{venue_id}-{sec_def['name']}"),
                        venue_id=venue_id,
                        name=sec_def["name"],
                        label=sec_def["label"],
                        capacity=sec_def["capacity"],
                        svg_path=sec_def["svg_path"],
                        center_x=sec_def["center_x"],
                        center_y=sec_def["center_y"],
                        floor=sec_def["floor"],
                        color=sec_def["color"],
                    )
                    session.add(section)

                # 이벤트에 venue_id 연결
                await session.execute(
                    select(Event).where(Event.id == event_id)
                )
                from sqlalchemy import update
                await session.execute(
                    update(Event).where(Event.id == event_id).values(venue_id=venue_id)
                )
                venue_count += 1

            await session.flush()
            print(f"       Created {venue_count} venues with sections.")

            # 5. Create bids on top-10 popular events
            print("[5/8] Creating bids on popular events...")

            bid_total = 0
            random.seed(42)  # Reproducible

            for evt_idx in TOP_EVENT_INDICES:
                evt = EVENTS[evt_idx]
                event_id = evt["id"]
                min_p = evt["min_price"]
                max_p = evt["max_price"] or min_p * 2

                # 5-15 bids per popular event
                num_bids = random.randint(5, 15)

                # Shuffle users and pick subset
                shuffled_users = list(USER_IDS)
                random.shuffle(shuffled_users)
                bid_users = shuffled_users[:num_bids]

                for user_id in bid_users:
                    # Random price between min and max (weighted toward middle-high)
                    price = round(
                        random.uniform(min_p * 0.8, max_p * 1.1), -3
                    )  # Round to nearest 1000
                    price = max(price, min_p)  # Ensure at least min_price

                    quantity = random.choices([1, 2, 3, 4], weights=[40, 35, 15, 10])[0]

                    bid = Bid(
                        id=uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-bid-{event_id}-{user_id}"),
                        user_id=user_id,
                        event_id=event_id,
                        max_willingness_to_pay=price,
                        quantity=quantity,
                        status=BidStatus.ACTIVE,
                    )
                    session.add(bid)
                    bid_total += 1

            await session.flush()
            print(f"       Created {bid_total} bids across top-10 events.")

            # 6. Create seat tiers for resale-enabled events
            print("[6/8] Creating seat tiers & tickets for resale events...")

            tier_count = 0
            ticket_count = 0

            # Build a lookup: (event_idx, tier_name) -> base_price for later use
            tier_base_prices = {}

            for event_idx in RESALE_EVENT_INDICES:
                evt = EVENTS[event_idx]
                event_id = evt["id"]

                for tier_idx, tier_def in enumerate(TIER_DEFS):
                    tier_id = TIER_IDS[(event_idx, tier_def["name"])]
                    base_price = tier_def["price_fn"](evt)

                    tier_base_prices[(event_idx, tier_idx)] = base_price

                    tier = SeatTier(
                        id=tier_id,
                        event_id=event_id,
                        name=tier_def["name"],
                        capacity=tier_def["capacity"],
                        base_price=base_price,
                        sale_mode="fixed_fcfs",
                        face_price=base_price,
                        min_price=base_price,
                        max_price_cap=base_price * 1.5,
                        resale_allowed=True,
                        resale_max_price=base_price * 1.5,
                    )
                    session.add(tier)
                    tier_count += 1

            await session.flush()
            print(f"       Created {tier_count} tiers for resale events.")

            # ── Create seats for ALL events ──────────────────────────────────
            print("[6.5/8] Creating seats for all events...")

            SECTION_LAYOUTS = {
                "VIP": {"rows": 5, "seats_per_row": 10},
                "VIP석": {"rows": 5, "seats_per_row": 10},
                "R석": {"rows": 8, "seats_per_row": 15},
                "S석": {"rows": 10, "seats_per_row": 20},
                "A석": {"rows": 10, "seats_per_row": 20},
                "B석": {"rows": 12, "seats_per_row": 15},
                "1층": {"rows": 10, "seats_per_row": 20},
                "2층": {"rows": 8, "seats_per_row": 25},
                "스탠딩": {"rows": 1, "seats_per_row": 50},
                "자유석": {"rows": 1, "seats_per_row": 50},
            }
            DEFAULT_LAYOUT = {"rows": 5, "seats_per_row": 20}

            seat_total = 0
            # Query all tiers from DB
            all_tiers_result = await session.execute(
                select(SeatTier).order_by(SeatTier.event_id)
            )
            all_tiers = all_tiers_result.scalars().all()

            for tier_obj in all_tiers:
                layout = SECTION_LAYOUTS.get(tier_obj.name, DEFAULT_LAYOUT)
                rows = layout["rows"]
                seats_per_row = layout["seats_per_row"]
                section_name = tier_obj.name
                created_in_tier = 0

                for row in range(1, rows + 1):
                    for seat_num in range(1, seats_per_row + 1):
                        if created_in_tier >= tier_obj.capacity:
                            break
                        # Quality: front rows + center seats = higher
                        row_score = 1.0 - (row - 1) / max(rows, 1) * 0.4
                        center = seats_per_row / 2
                        col_score = 1.0 - abs(seat_num - center) / center * 0.3
                        quality = round(row_score * col_score, 3)

                        seat = Seat(
                            id=uuid.uuid5(
                                uuid.NAMESPACE_DNS,
                                f"seat-{tier_obj.event_id}-{tier_obj.id}-{row}-{seat_num}",
                            ),
                            tier_id=tier_obj.id,
                            event_id=tier_obj.event_id,
                            section=section_name,
                            row_number=row,
                            seat_number=seat_num,
                            quality_score=quality,
                            label=f"{section_name} {row}열 {seat_num}번",
                            status=SeatStatus.AVAILABLE,
                            x=float(seat_num),
                            y=float(row),
                        )
                        session.add(seat)
                        created_in_tier += 1
                        seat_total += 1
                    if created_in_tier >= tier_obj.capacity:
                        break

            await session.flush()
            print(f"       Created {seat_total} seats across all events.")

            # Create tickets: 10 per resale-enabled event distributed across tiers & users
            # Tier distribution: first 2 VIP, next 4 R, last 4 S
            tier_distribution = [0, 0, 1, 1, 1, 1, 2, 2, 2, 2]  # tier_idx for each ticket

            for event_idx in RESALE_EVENT_INDICES:
                evt = EVENTS[event_idx]
                event_id = evt["id"]

                for ticket_idx in range(TICKETS_PER_EVENT):
                    ticket_id = TICKET_IDS_BY_EVENT[event_idx][ticket_idx]
                    tier_idx = tier_distribution[ticket_idx]
                    tier_name = TIER_DEFS[tier_idx]["name"]
                    tier_id = TIER_IDS[(event_idx, tier_name)]
                    base_price = tier_base_prices[(event_idx, tier_idx)]

                    # Assign owner: cycle through regular users
                    owner_id = USER_IDS[ticket_idx % len(USER_IDS)]

                    ticket = Ticket(
                        id=ticket_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        current_owner_id=owner_id,
                        original_owner_id=owner_id,
                        is_resalable=True,
                        status=TicketStatus.ACTIVE,
                        purchase_price=base_price,
                        sale_mode="fixed_fcfs",
                        resale_max_price=base_price * 1.5,
                    )
                    session.add(ticket)
                    ticket_count += 1

            await session.flush()
            print(f"       Created {tier_count} seat tiers + {ticket_count} tickets.")

            # 7. Create resale listings and buy orders
            print("[7/8] Creating resale listings & buy orders...")

            listing_count = 0
            buy_order_count = 0

            for event_idx in RESALE_EVENT_INDICES:
                evt = EVENTS[event_idx]
                event_id = evt["id"]

                # ~40% of tickets get listings (4 out of 10)
                listing_ticket_indices = [0, 3, 5, 8]

                for li, ticket_idx in enumerate(listing_ticket_indices):
                    ticket_id = TICKET_IDS_BY_EVENT[event_idx][ticket_idx]
                    tier_idx = tier_distribution[ticket_idx]
                    base_price = tier_base_prices[(event_idx, tier_idx)]
                    owner_id = USER_IDS[ticket_idx % len(USER_IDS)]

                    # Asking price between 0.9x and 1.4x of base_price (deterministic via seed)
                    price_multiplier = 0.9 + (li * 0.167)  # 0.9, 1.067, 1.234, 1.4
                    asking_price = round(base_price * price_multiplier, -2)  # round to 100

                    platform_fee = round(asking_price * 0.05, 2)
                    artist_royalty = round(asking_price * 0.03, 2)
                    seller_receives = round(asking_price - platform_fee - artist_royalty, 2)

                    listing = ResaleListingModel(
                        id=uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-listing-{event_idx}-{li}"),
                        ticket_id=ticket_id,
                        seller_id=owner_id,
                        asking_price=asking_price,
                        status=ResaleListingStatus.ACTIVE,
                        platform_fee=platform_fee,
                        artist_royalty=artist_royalty,
                        seller_receives=seller_receives,
                    )
                    session.add(listing)
                    listing_count += 1

                # Buy orders: 4 per event from different users
                buy_order_user_offsets = [1, 3, 6, 8]
                for bi, user_offset in enumerate(buy_order_user_offsets):
                    buyer_id = USER_IDS[user_offset]
                    # Pick a random tier for the buy order (cycle through)
                    tier_idx = bi % len(TIER_DEFS)
                    tier_name = TIER_DEFS[tier_idx]["name"]
                    tier_id = TIER_IDS[(event_idx, tier_name)]
                    base_price = tier_base_prices[(event_idx, tier_idx)]

                    # Max price between 0.8x and 1.1x of base_price
                    price_multiplier = 0.8 + (bi * 0.1)  # 0.8, 0.9, 1.0, 1.1
                    max_price = round(base_price * price_multiplier, -2)

                    buy_order = ResaleBuyOrderModel(
                        id=uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-buyorder-{event_idx}-{bi}"),
                        event_id=event_id,
                        tier_id=tier_id,
                        buyer_id=buyer_id,
                        max_price=max_price,
                        status=ResaleBuyOrderStatus.ACTIVE,
                    )
                    session.add(buy_order)
                    buy_order_count += 1

            await session.flush()
            print(f"       Created {listing_count} resale listings + {buy_order_count} buy orders.")

            # 8. Create ownership transfer records (historical trade data)
            print("[8/8] Creating ownership transfer history...")

            transfer_count = 0

            for event_idx in RESALE_EVENT_INDICES:
                evt = EVENTS[event_idx]

                # 15 historical trades per event, spread over last 48 hours
                num_transfers = 15

                for t_idx in range(num_transfers):
                    # Spread across 48 hours: every ~3.2 hours
                    hours_ago = 48.0 - (t_idx * (48.0 / num_transfers))
                    transferred_at = NOW - timedelta(hours=hours_ago)

                    # Cycle through tickets for this event
                    ticket_idx = t_idx % TICKETS_PER_EVENT
                    ticket_id = TICKET_IDS_BY_EVENT[event_idx][ticket_idx]

                    # Determine base_price from tier
                    t_tier_idx = tier_distribution[ticket_idx]
                    base_price = tier_base_prices[(event_idx, t_tier_idx)]

                    # Price varies +/-15% around base_price (deterministic pattern)
                    # Use a sine-like pattern for realistic variation
                    variation = (
                        1.0 + 0.15 * ((t_idx % 5) - 2) / 2.0
                    )  # -0.15, -0.075, 0, 0.075, 0.15
                    trade_price = round(base_price * variation, -2)

                    platform_fee = round(trade_price * 0.05, 2)
                    artist_royalty = round(trade_price * 0.03, 2)
                    seller_amount = round(trade_price - platform_fee - artist_royalty, 2)

                    # From user -> To user (different users for each trade)
                    from_user_id = USER_IDS[t_idx % len(USER_IDS)]
                    to_user_id = USER_IDS[(t_idx + 3) % len(USER_IDS)]

                    transfer = OwnershipTransfer(
                        id=uuid.uuid5(uuid.NAMESPACE_DNS, f"pickket-transfer-{event_idx}-{t_idx}"),
                        ticket_id=ticket_id,
                        from_user_id=from_user_id,
                        to_user_id=to_user_id,
                        transfer_type=TransferType.RESALE,
                        price=trade_price,
                        seller_amount=seller_amount,
                        platform_fee=platform_fee,
                        artist_royalty=artist_royalty,
                        transferred_at=transferred_at,
                    )
                    session.add(transfer)
                    transfer_count += 1

            await session.flush()
            print(f"       Created {transfer_count} ownership transfers (trade history).")

        # session.begin() auto-commits here on successful exit

    await engine.dispose()

    # Summary
    print()
    print("=" * 60)
    print("  SEED COMPLETE")
    print("=" * 60)
    print()
    print(f"  Organizers:             {organizer_count}")
    print(f"  Regular users:          {user_count}")
    print(f"  Events:                 {event_count}")
    print(f"  Bids:                   {bid_total}")
    print()
    print("  --- Resale Marketplace ---")
    print(f"  Resale-enabled events:  {len(RESALE_EVENT_INDICES)}")
    print(f"  Seat tiers:             {tier_count}")
    print(f"  Tickets:                {ticket_count}")
    print(f"  Resale listings:        {listing_count}")
    print(f"  Buy orders:             {buy_order_count}")
    print(f"  Ownership transfers:    {transfer_count}")
    print()

    featured_events = [e for e in EVENTS if e["is_featured"]]
    print(f"  Featured events ({len(featured_events)}):")
    for e in featured_events:
        print(f"    - {e['title']}")

    bidding_open = [e for e in EVENTS if e["status"] == EventStatus.BIDDING_OPEN]
    draft = [e for e in EVENTS if e["status"] == EventStatus.DRAFT]
    print()
    print(f"  BIDDING_OPEN:   {len(bidding_open)}")
    print(f"  DRAFT:          {len(draft)}")
    print()

    print("  Top-10 events by bid_count:")
    for rank, idx in enumerate(TOP_EVENT_INDICES, 1):
        e = EVENTS[idx]
        print(f"    {rank:2d}. {e['title'][:45]:45s}  bid_count={e['bid_count']}")

    resale_events = [EVENTS[i] for i in RESALE_EVENT_INDICES]
    print()
    print("  Resale-enabled events:")
    for e in resale_events:
        print(f"    - {e['title'][:50]}")

    print()
    # print("  All passwords: test-only-password")  # removed: do not log credentials
    print()
    print("  Organizer logins:")
    for org in ORGANIZERS:
        print(f"    {org['email']}")
    print()
    print("  Regular user logins:")
    for u in REGULAR_USERS:
        print(f"    {u['email']}")
    print()


if __name__ == "__main__":
    # 프로덕션 보호(P620 감사 P2-3) — 라이브 DB 에 데모/테스트 계정 잔재 방지.
    import os as _os
    if settings.ENVIRONMENT == "production" and _os.environ.get("SEED_ALLOW_PRODUCTION") != "1":
        print("🚫 ENVIRONMENT=production 에서는 시드를 실행하지 않습니다 "
              "(테스트/데모 계정 잔재 방지). 정말 필요하면 SEED_ALLOW_PRODUCTION=1 로 실행.")
    else:
        asyncio.run(seed())
