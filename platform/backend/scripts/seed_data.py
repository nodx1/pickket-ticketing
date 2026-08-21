#!/usr/bin/env python3
"""Pickket 대규모 시드 데이터 생성 스크립트.

1000명 유저, 100개 이벤트, 3000개 주문, 2500장 티켓, 500개 리뷰,
5개 팬클럽 + 200개 멤버십을 DB에 삽입한다.

ORM 모델과 실제 DB 스키마 차이를 자동 감지하여, 존재하는 컬럼만 삽입한다.

사용법:
    cd backend && .venv/bin/python scripts/seed_data.py
    cd backend && .venv/bin/python scripts/seed_data.py --dry-run
    cd backend && .venv/bin/python scripts/seed_data.py --clean
    cd backend && .venv/bin/python scripts/seed_data.py --clean --seed
"""

import argparse
import asyncio
import hashlib
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from faker import Faker
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# ---------------------------------------------------------------------------
# Add project root to sys.path so 'app' package is importable
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.event import Event, EventStatus, SeatTier  # noqa: E402
from app.models.order import Order, OrderStatus, OrderType  # noqa: E402
from app.models.ticket import Ticket, TicketStatus  # noqa: E402
from app.models.review import Review  # noqa: E402
from app.models.fanclub import (  # noqa: E402
    Fanclub,
    FanclubMembership,
    MembershipTier,
    MembershipStatus,
    CommunityType,
)
from app.models.venue import Venue  # noqa: E402
from app.models.organizer import OrganizerProfile, OrganizerStatus  # noqa: E402
from app.models.point import PointWallet, PointType  # noqa: E402

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NOW = datetime.now(timezone.utc)
SEED_EMAIL_DOMAIN = "@seedtest.pickket.kr"
SEED_PASSWORD_PLAIN = "PickketTest2026!"
SEED_IDENTIFIER = "seedtest.pickket.kr"  # used to detect seed data

NUM_USERS = 1000
NUM_ORGANIZERS = 50  # 5% of users
NUM_ADMINS = 5
NUM_EVENTS = 100
NUM_ORDERS = 3000
NUM_TICKETS = 2500
NUM_REVIEWS = 500
NUM_FANCLUBS = 5
NUM_MEMBERSHIPS = 200

# Faker 한국어 로케일
fake = Faker("ko_KR")
Faker.seed(42)
random.seed(42)

# Event categories (matches existing categories in the system)
CATEGORIES = ["CONCERT", "SPORTS", "MUSICAL", "EXHIBITION", "FESTIVAL", "CLASSICAL", "ESPORTS"]

# Korean cities and venues
KOREAN_CITIES = [
    "서울",
    "부산",
    "인천",
    "대구",
    "대전",
    "광주",
    "울산",
    "세종",
    "수원",
    "고양",
    "용인",
    "성남",
    "제주",
    "창원",
    "천안",
]

VENUE_NAMES = {
    "서울": [
        "올림픽공원 체조경기장",
        "KSPO DOME",
        "잠실종합운동장",
        "고척스카이돔",
        "블루스퀘어",
        "세종문화회관",
        "예술의전당",
        "LG아트센터",
    ],
    "부산": ["벡스코 제1전시장", "부산시민회관", "드림씨어터", "KBS부산홀"],
    "인천": ["인천아트센터", "인천종합문화예술회관", "송도컨벤시아"],
    "대구": ["대구엑스코", "대구콘서트하우스", "수성아트피아"],
    "대전": ["대전컨벤션센터", "대전예술의전당"],
    "광주": ["김대중컨벤션센터", "광주문화예술회관"],
    "울산": ["울산문화예술회관"],
    "세종": ["세종문화예술회관"],
    "수원": ["수원SK아트리움", "경기아트센터"],
    "고양": ["킨텍스", "고양아람누리"],
    "용인": ["용인포은아트홀"],
    "성남": ["성남아트센터"],
    "제주": ["제주아트센터", "제주국제컨벤션센터"],
    "창원": ["성산아트홀"],
    "천안": ["천안예술의전당"],
}

# Korean artist/team names for events
CONCERT_ARTISTS = [
    "BTS",
    "BLACKPINK",
    "IVE",
    "NewJeans",
    "aespa",
    "SEVENTEEN",
    "Stray Kids",
    "LE SSERAFIM",
    "ENHYPEN",
    "(G)I-DLE",
    "TXT",
    "ATEEZ",
    "NMIXX",
    "ITZY",
    "EXO",
    "NCT 127",
    "Red Velvet",
    "SHINee",
    "TWICE",
    "GOT7",
]

SPORTS_TEAMS = [
    "서울 FC",
    "전북 현대",
    "울산 현대",
    "포항 스틸러스",
    "수원 삼성",
    "LG 트윈스",
    "두산 베어스",
    "SSG 랜더스",
    "KT 위즈",
    "삼성 라이온즈",
    "SK 나이츠",
    "삼성 썬더스",
    "현대모비스 피버스",
    "KT 소닉붐",
]

MUSICAL_TITLES = [
    "레미제라블",
    "오페라의 유령",
    "캣츠",
    "위키드",
    "라이온 킹",
    "시카고",
    "맘마미아",
    "지킬앤하이드",
    "엘리자벳",
    "킹키부츠",
    "빌리 엘리엇",
    "디어 에반 핸슨",
    "해밀턴",
    "모차르트!",
    "마틸다",
]

EXHIBITION_TITLES = [
    "인상파 특별전",
    "반 고흐 몰입전",
    "팀랩 보더리스",
    "무한의 공간",
    "미디어아트 페스티벌",
    "현대미술의 오늘",
    "사진전: 한국의 풍경",
    "디자인 서울 2026",
    "세계 공예 비엔날레",
    "한국 도자기 명품전",
]

FESTIVAL_NAMES = [
    "자라섬 재즈 페스티벌",
    "부산 국제영화제",
    "인천 펜타포트 락 페스티벌",
    "서울 재즈 페스티벌",
    "울트라 코리아",
    "워터밤 서울",
    "서울 세계불꽃축제",
    "보령 머드 축제",
    "춘천 마임 축제",
    "대구 치맥 페스티벌",
]

CLASSICAL_TITLES = [
    "서울시향 정기공연",
    "KBS교향악단 신년음악회",
    "국립심포니 오케스트라",
    "피아노 리사이틀: 조성진",
    "바이올린 독주회",
    "오페라 갈라 콘서트",
    "실내악의 밤",
    "합창 축제",
    "관악 앙상블",
    "첼로 독주회",
]

ESPORTS_TITLES = [
    "LOL 월드 챔피언십",
    "LCK 서머 결승",
    "발로란트 마스터즈",
    "오버워치 리그 플레이오프",
    "배틀그라운드 글로벌 시리즈",
]

# Review templates
REVIEW_TEMPLATES_GOOD = [
    "정말 멋진 공연이었습니다! 다음에도 꼭 오고 싶어요.",
    "기대 이상이었어요. 음향도 좋고 좌석도 편안했습니다.",
    "최고의 경험이었습니다. 아티스트가 정말 대단했어요.",
    "분위기가 너무 좋았어요. 친구들에게 강력 추천합니다.",
    "매진될 줄 알았는데 픽켓 덕분에 티켓 구할 수 있었어요!",
    "좌석 배치가 잘 되어있어서 어디서든 잘 보였어요.",
    "굿즈도 다양하고 공연 퀄리티도 최상급이었습니다.",
    "입장 과정이 매끄러웠고 QR 체크인이 편리했어요.",
    "다음 회차도 반드시 참석할 예정입니다. 감사합니다!",
    "가격 대비 만족도가 매우 높은 공연이었어요.",
]

REVIEW_TEMPLATES_MID = [
    "전반적으로 괜찮았지만 음향이 조금 아쉬웠어요.",
    "좌석이 좀 좁았는데 공연 자체는 좋았습니다.",
    "기대했던 것만큼은 아니었지만 나쁘지 않았어요.",
    "접근성이 좀 불편했지만 공연은 괜찮았습니다.",
    "가격이 조금 비싼 감이 있지만 만족합니다.",
]

REVIEW_TEMPLATES_BAD = [
    "음향 상태가 좋지 않아서 아쉬웠습니다.",
    "좌석이 너무 뒤쪽이라 무대가 잘 안 보였어요.",
    "기대에 못 미치는 공연이었습니다.",
    "주차가 불편하고 대기 시간이 너무 길었어요.",
    "다음에는 더 나은 준비가 되었으면 좋겠습니다.",
]

# Fanclub configurations
FANCLUB_CONFIGS = [
    {
        "name": "BTS ARMY 코리아",
        "artist_name": "BTS",
        "community_type": CommunityType.FANCLUB.value,
        "domain": "concert",
        "max_members": 500000,
        "is_official": True,
    },
    {
        "name": "BLINK 한국",
        "artist_name": "BLACKPINK",
        "community_type": CommunityType.FANCLUB.value,
        "domain": "concert",
        "max_members": 300000,
        "is_official": True,
    },
    {
        "name": "KBO 팬연합",
        "artist_name": "KBO 프로야구",
        "community_type": CommunityType.SUPPORTER.value,
        "domain": "sports",
        "max_members": 100000,
        "is_official": False,
    },
    {
        "name": "뮤지컬 사랑 모임",
        "artist_name": "뮤지컬",
        "community_type": CommunityType.ASSOCIATION.value,
        "domain": "musical",
        "max_members": 50000,
        "is_official": False,
    },
    {
        "name": "재즈 페스티벌 동호회",
        "artist_name": "자라섬 재즈",
        "community_type": CommunityType.SOCIETY.value,
        "domain": "festival",
        "max_members": 20000,
        "is_official": False,
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """bcrypt 해싱 (app.core.security.hash_password와 동일)."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def generate_qr_hash() -> str:
    """Generate a random QR code hash."""
    return hashlib.sha256(uuid.uuid4().bytes).hexdigest()


def random_datetime(start: datetime, end: datetime) -> datetime:
    """start ~ end 사이의 랜덤 datetime 반환."""
    delta = end - start
    seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=seconds)


def generate_event_title(category: str) -> str:
    """카테고리별 이벤트 제목 생성."""
    if category == "CONCERT":
        artist = random.choice(CONCERT_ARTISTS)
        return f"{artist} 2026 월드 투어 서울"
    elif category == "SPORTS":
        teams = random.sample(SPORTS_TEAMS, 2)
        return f"{teams[0]} vs {teams[1]}"
    elif category == "MUSICAL":
        return f"뮤지컬 <{random.choice(MUSICAL_TITLES)}>"
    elif category == "EXHIBITION":
        return random.choice(EXHIBITION_TITLES)
    elif category == "FESTIVAL":
        return random.choice(FESTIVAL_NAMES)
    elif category == "CLASSICAL":
        return random.choice(CLASSICAL_TITLES)
    elif category == "ESPORTS":
        return random.choice(ESPORTS_TITLES)
    return f"{fake.catch_phrase()} 이벤트"


def get_review_text(rating: int) -> tuple[str, str]:
    """평점에 맞는 리뷰 제목 + 내용 반환."""
    if rating >= 4:
        content = random.choice(REVIEW_TEMPLATES_GOOD)
        title = random.choice(["최고!", "강력 추천", "만족합니다", "좋았어요", "또 가고 싶어요"])
    elif rating >= 3:
        content = random.choice(REVIEW_TEMPLATES_MID)
        title = random.choice(["보통이에요", "괜찮았어요", "무난했습니다", "나쁘지 않아요"])
    else:
        content = random.choice(REVIEW_TEMPLATES_BAD)
        title = random.choice(["아쉬워요", "기대 이하", "개선 필요", "실망"])
    return title, content


def weighted_rating() -> int:
    """4점대 중심 정규분포 평점 (1~5)."""
    r = random.gauss(4.0, 0.8)
    return max(1, min(5, round(r)))


def progress(label: str, current: int, total: int, step: int = 100):
    """간단한 진행 표시."""
    if current % step == 0 or current == total:
        pct = current / total * 100
        print(f"  [{label}] {current}/{total} ({pct:.0f}%)")


# ---------------------------------------------------------------------------
# Data generation functions
# ---------------------------------------------------------------------------


def generate_users(hashed_pw: str) -> list[dict[str, Any]]:
    """유저 1000명 데이터 생성."""
    users = []
    for i in range(NUM_USERS):
        idx = i + 1
        email = f"testuser{idx:04d}{SEED_EMAIL_DOMAIN}"
        is_organizer = idx <= NUM_ORGANIZERS  # 첫 50명 = 주최자
        is_admin = idx <= NUM_ADMINS  # 첫 5명 = 관리자

        # 랜덤 속성
        verification_level = random.choices([0, 1, 2, 3], weights=[5, 15, 70, 10])[0]
        loyalty_score = round(random.uniform(0.0, 1.0), 2)
        history_score = round(random.uniform(0.0, 5.0), 2)
        no_show_rate = round(random.uniform(0.0, 0.15), 3)
        cancel_rate = round(random.uniform(0.0, 0.2), 3)
        dispute_rate = round(random.uniform(0.0, 0.05), 3)

        city = random.choice(KOREAN_CITIES)
        districts = {
            "서울": [
                "강남구",
                "서초구",
                "마포구",
                "종로구",
                "용산구",
                "송파구",
                "영등포구",
                "성동구",
            ],
            "부산": ["해운대구", "부산진구", "사하구", "동래구"],
            "인천": ["남동구", "부평구", "연수구"],
        }
        district = random.choice(districts.get(city, ["중구", "동구", "서구"]))

        user_data = {
            "id": uuid.uuid4(),
            "email": email,
            "hashed_password": hashed_pw,
            "name": fake.name(),
            "phone": f"010-{random.randint(1000, 9999)}-{random.randint(1000, 9999)}",
            "is_verified": True,
            "is_organizer": is_organizer,
            "is_active": True,
            "verification_level": verification_level,
            "loyalty_score": loyalty_score,
            "history_score": history_score,
            "is_fanclub_member": random.random() < 0.15,
            "no_show_rate": no_show_rate,
            "cancel_rate": cancel_rate,
            "dispute_rate": dispute_rate,
            "is_admin": is_admin,
            # 관리자만 admin_role 부여. 비관리자는 NULL — viewer 를 뿌리면 나중에 대시보드
            # 게이트를 admin_role 기준으로 바꿀 때 외부주최사·테스트계정이 접근하는 함정이 됨
            # (P620 감사 P2-4). admin 계정은 super_admin({"*"}).
            "admin_role": "super_admin" if is_admin else None,
            "abuse_score": round(random.uniform(0.0, 0.1), 3) if random.random() < 0.05 else 0.0,
            "preferred_language": "ko",
            "timezone": "Asia/Seoul",
            "nationality": "KR",
            "date_of_birth": fake.date_of_birth(minimum_age=18, maximum_age=65),
            "residential_city": city,
            "residential_district": district,
            "residence_verified": verification_level >= 2,
            "residence_verified_at": NOW - timedelta(days=random.randint(1, 365))
            if verification_level >= 2
            else None,
            "created_at": random_datetime(NOW - timedelta(days=365), NOW - timedelta(days=30)),
            "updated_at": NOW - timedelta(days=random.randint(0, 30)),
        }
        users.append(user_data)

        if (idx) % 200 == 0 or idx == NUM_USERS:
            progress("유저 생성", idx, NUM_USERS, step=200)

    return users


def generate_venues() -> list[dict[str, Any]]:
    """주요 공연장 데이터 생성 (이벤트에 연결)."""
    venues = []
    for city, venue_list in VENUE_NAMES.items():
        for vname in venue_list:
            venues.append(
                {
                    "id": uuid.uuid4(),
                    "name": vname,
                    "city": city,
                    "address": f"{city} {fake.road_name()} {random.randint(1, 200)}",
                    "total_capacity": random.choice(
                        [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000]
                    ),
                }
            )
    return venues


def generate_events(organizer_ids: list[uuid.UUID], venues: list[dict]) -> list[dict[str, Any]]:
    """이벤트 100개 생성: 과거 30 / 진행중 20 / 미래 50."""
    events = []

    for i in range(NUM_EVENTS):
        idx = i + 1
        category = random.choice(CATEGORIES)
        title = generate_event_title(category)
        organizer_id = random.choice(organizer_ids)
        venue_data = random.choice(venues)

        # 시간 구간 결정: 과거 30, 진행중 20, 미래 50
        if i < 30:
            # 과거 이벤트 (1~180일 전)
            event_date = NOW - timedelta(days=random.randint(1, 180))
            status = EventStatus.COMPLETED
        elif i < 50:
            # 진행 중 이벤트 (지금 ~ 7일 내)
            event_date = NOW + timedelta(hours=random.randint(1, 168))
            status = random.choice(
                [
                    EventStatus.BIDDING_OPEN,
                    EventStatus.BIDDING_CLOSED,
                    EventStatus.ALLOCATED,
                    EventStatus.APPROVED,
                ]
            )
        else:
            # 미래 이벤트 (7~180일 후)
            event_date = NOW + timedelta(days=random.randint(7, 180))
            status = random.choice(
                [
                    EventStatus.DRAFT,
                    EventStatus.APPROVED,
                    EventStatus.BIDDING_OPEN,
                    EventStatus.PENDING_REVIEW,
                ]
            )

        bidding_opens = event_date - timedelta(days=random.randint(14, 60))
        bidding_closes = event_date - timedelta(days=random.randint(1, 13))
        total_seats = random.choice([300, 500, 800, 1000, 1500, 2000, 3000, 5000])
        min_price = random.choice(
            [30000, 50000, 66000, 77000, 88000, 99000, 110000, 132000, 150000, 200000]
        )
        max_price = min_price * random.choice([1.5, 2.0, 2.5, 3.0])

        # Artist / team info
        artist_name = None
        home_team = None
        away_team = None
        if category == "CONCERT":
            artist_name = random.choice(CONCERT_ARTISTS)
        elif category == "SPORTS":
            teams = random.sample(SPORTS_TEAMS, 2)
            home_team = teams[0]
            away_team = teams[1]
        elif category == "ESPORTS":
            artist_name = random.choice(["T1", "Gen.G", "DRX", "HLE", "KT Rolster"])

        event_data = {
            "id": uuid.uuid4(),
            "organizer_id": organizer_id,
            "title": title,
            # events.slug = NOT NULL + UNIQUE(ix_events_slug). 제목이 한글이라 slugify 대신
            # idx + uuid 접미로 유니크 보장(<=80자). 시드 스키마 드리프트 수정.
            "slug": f"seed-evt-{idx}-{uuid.uuid4().hex[:8]}",
            "description": f"{title} - {fake.paragraph(nb_sentences=3)}",
            "venue": venue_data["name"],
            "venue_id": venue_data["id"],
            "event_date": event_date,
            "bidding_opens_at": bidding_opens,
            "bidding_closes_at": bidding_closes,
            "total_seats": total_seats,
            "min_price": float(min_price),
            "max_price": float(max_price),
            # ck_events_category_valid 는 소문자 정본(concert/musical/sports/classical/…) 강제.
            # bulk core insert 는 ORM @validates(normalize_category) 우회 → 저장 시 소문자화.
            "category": category.lower(),
            "location_city": venue_data["city"],
            "artist_name": artist_name,
            "home_team": home_team,
            "away_team": away_team,
            "age_restriction": random.choice([None, "전체", "12세", "15세", "19세"]),
            "is_featured": random.random() < 0.2,
            "bid_count": random.randint(0, 500)
            if status not in (EventStatus.DRAFT, EventStatus.PENDING_REVIEW)
            else 0,
            "view_count": random.randint(100, 50000),
            "duration_minutes": random.choice([90, 120, 150, 180, 210, 240]),
            "status": status,
            "currency": "KRW",
            "event_timezone": "Asia/Seoul",
            "current_phase": "completed" if status == EventStatus.COMPLETED else "setup",
            "seat_type": random.choice(["assigned", "unassigned"]),
            "delivery_method": "mobile",
            "mobile_ticket_enabled": True,
            "resale_enabled": random.random() < 0.3,
            "created_at": bidding_opens - timedelta(days=random.randint(7, 30)),
            "updated_at": NOW - timedelta(days=random.randint(0, 7)),
        }
        events.append(event_data)

        if idx % 20 == 0 or idx == NUM_EVENTS:
            progress("이벤트 생성", idx, NUM_EVENTS, step=20)

    return events


def generate_seat_tiers(events: list[dict]) -> list[dict[str, Any]]:
    """각 이벤트에 2~3개 좌석 등급 생성."""
    tiers = []
    tier_configs = [
        ("VIP", 1.5, 0.15),
        ("R석", 1.0, 0.35),
        ("S석", 0.7, 0.30),
        ("A석", 0.5, 0.20),
    ]

    for event in events:
        num_tiers = random.choice([2, 2, 3, 3, 3])
        selected_configs = random.sample(tier_configs, num_tiers)
        remaining_seats = event["total_seats"]

        for j, (tier_name, price_mult, _cap_ratio) in enumerate(selected_configs):
            is_last = j == len(selected_configs) - 1
            if is_last:
                capacity = remaining_seats
            else:
                capacity = max(50, int(event["total_seats"] * _cap_ratio))
                remaining_seats -= capacity

            base_price = event["min_price"] * price_mult

            # sale_mode는 이벤트 상태에 따라 결정
            status = event["status"]
            if status in (EventStatus.BIDDING_OPEN, EventStatus.BIDDING_CLOSED, EventStatus.ALLOCATING, EventStatus.ALLOCATED):
                sale_mode = "point_lottery"
            elif status == EventStatus.COMPLETED:
                sale_mode = random.choice(["fixed_fcfs", "point_lottery"])
            elif status == EventStatus.DRAFT and random.random() < 0.3:
                sale_mode = "fanclub_presale"
            else:
                sale_mode = "fixed_fcfs"

            tier_data = {
                "id": uuid.uuid4(),
                "event_id": event["id"],
                "name": tier_name,
                "capacity": max(capacity, 10),
                "base_price": round(base_price, -2),  # 100원 단위 반올림
                "sale_mode": sale_mode,
                "face_price": round(base_price, -2),
                "min_price": round(base_price * 0.8, -2),
                "max_price_cap": round(base_price * 2.0, -2),
                "sold_count": 0,
                "seating_type": event.get("seat_type", "assigned"),
                "allow_group_tickets": True,
                "max_group_size": 4,
            }
            tiers.append(tier_data)

    print(f"  [좌석등급] 총 {len(tiers)}개 생성 완료")
    return tiers


def generate_orders(
    user_ids: list[uuid.UUID],
    events: list[dict],
    tiers_by_event: dict[uuid.UUID, list[dict]],
) -> list[dict[str, Any]]:
    """주문 3000개 생성 (유저-이벤트 매핑)."""
    orders = []

    # 진행중/완료 이벤트만 주문 대상
    eligible_events = [
        e for e in events if e["status"] not in (EventStatus.DRAFT, EventStatus.PENDING_REVIEW)
    ]
    if not eligible_events:
        eligible_events = events[:50]

    for i in range(NUM_ORDERS):
        idx = i + 1
        user_id = random.choice(user_ids)
        event = random.choice(eligible_events)
        event_tiers = tiers_by_event.get(event["id"], [])
        if not event_tiers:
            continue

        tier = random.choice(event_tiers)

        # Status distribution: confirmed 60%, paid 20%, cancelled 10%, expired 10%
        status_roll = random.random()
        if status_roll < 0.60:
            status = OrderStatus.CONFIRMED
        elif status_roll < 0.80:
            status = OrderStatus.PAID
        elif status_roll < 0.90:
            status = OrderStatus.CANCELLED
        else:
            status = OrderStatus.EXPIRED

        quantity = random.choices([1, 2, 3, 4], weights=[50, 30, 15, 5])[0]
        unit_price = tier["base_price"]
        total_amount = unit_price * quantity

        # Payment identifiers for paid/confirmed orders
        payment_id = None
        pg_transaction_id = None
        pg_approved_at = None
        captured_at = None
        if status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            payment_id = f"pay_seed_{uuid.uuid4().hex[:16]}"
            pg_transaction_id = f"pg_seed_{uuid.uuid4().hex[:20]}"
            pg_approved_at = event["bidding_closes_at"] + timedelta(hours=random.randint(1, 48))
            captured_at = pg_approved_at + timedelta(minutes=random.randint(1, 30))

        order_data = {
            "id": uuid.uuid4(),
            "user_id": user_id,
            "event_id": event["id"],
            "tier_id": tier["id"],
            "order_type": OrderType.PURCHASE,
            "status": status,
            "quantity": quantity,
            "unit_price": float(unit_price),
            "total_amount": float(total_amount),
            "payment_currency": "KRW",
            "payment_id": payment_id,
            "pg_provider": "portone" if payment_id else None,
            "pg_transaction_id": pg_transaction_id,
            "pg_approved_at": pg_approved_at,
            "captured_at": captured_at,
            "created_at": event["bidding_closes_at"] + timedelta(hours=random.randint(0, 24)),
            "updated_at": NOW - timedelta(days=random.randint(0, 14)),
        }
        orders.append(order_data)

        if idx % 500 == 0 or idx == NUM_ORDERS:
            progress("주문 생성", idx, NUM_ORDERS, step=500)

    return orders


def generate_tickets(
    orders: list[dict],
    tiers_by_event: dict[uuid.UUID, list[dict]],
) -> list[dict[str, Any]]:
    """confirmed/paid 주문 기반 티켓 2500장 생성."""
    tickets = []
    ticket_count = 0

    # confirmed/paid 주문만 티켓 발행 대상
    eligible_orders = [
        o for o in orders if o["status"] in (OrderStatus.CONFIRMED, OrderStatus.PAID)
    ]
    random.shuffle(eligible_orders)

    for order in eligible_orders:
        if ticket_count >= NUM_TICKETS:
            break

        tier_id = order["tier_id"]
        for _ in range(order["quantity"]):
            if ticket_count >= NUM_TICKETS:
                break

            ticket_data = {
                "id": uuid.uuid4(),
                "event_id": order["event_id"],
                "tier_id": tier_id,
                "original_owner_id": order["user_id"],
                "current_owner_id": order["user_id"],
                "purchase_price": float(order["unit_price"]),
                "sale_mode": "fixed_fcfs",
                "purchase_order_id": order["id"],
                "status": TicketStatus.ACTIVE,
                "qr_code_hash": generate_qr_hash(),
                "identity_verified": random.random() < 0.8,
                "is_resalable": True,
                "resale_max_price": float(order["unit_price"] * 1.5),
                "transfer_count": 0,
                "created_at": order["created_at"] + timedelta(minutes=random.randint(1, 60)),
            }
            tickets.append(ticket_data)
            ticket_count += 1

        if ticket_count % 500 == 0:
            progress("티켓 생성", ticket_count, NUM_TICKETS, step=500)

    progress("티켓 생성", len(tickets), NUM_TICKETS, step=1)
    return tickets


def generate_reviews(
    user_ids: list[uuid.UUID],
    past_events: list[dict],
) -> list[dict[str, Any]]:
    """과거 이벤트 대상 리뷰 500개 생성."""
    reviews = []

    if not past_events:
        print("  [리뷰] 과거 이벤트가 없어 리뷰 생성 건너뜀")
        return reviews

    for i in range(NUM_REVIEWS):
        idx = i + 1
        rating = weighted_rating()
        title, content = get_review_text(rating)
        event = random.choice(past_events)

        review_data = {
            "id": uuid.uuid4(),
            "user_id": random.choice(user_ids),
            "event_id": event["id"],
            "rating": rating,
            "title": title,
            "content": content,
            "is_verified_attendee": random.random() < 0.7,
            "helpful_count": random.randint(0, 50) if rating >= 4 else random.randint(0, 10),
            "is_hidden": False,
            "created_at": event["event_date"] + timedelta(days=random.randint(1, 14)),
            "updated_at": event["event_date"] + timedelta(days=random.randint(1, 30)),
        }
        reviews.append(review_data)

        if idx % 100 == 0 or idx == NUM_REVIEWS:
            progress("리뷰 생성", idx, NUM_REVIEWS, step=100)

    return reviews


def generate_fanclubs(organizer_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """팬클럽 5개 생성."""
    fanclubs = []
    for config in FANCLUB_CONFIGS:
        fanclub_data = {
            "id": uuid.uuid4(),
            "name": config["name"],
            "artist_name": config["artist_name"],
            "description": f"{config['artist_name']} 공식 팬 커뮤니티입니다.",
            "organizer_id": random.choice(organizer_ids),
            "max_members": config["max_members"],
            "is_official": config["is_official"],
            "is_active": True,
            "community_type": config["community_type"],
            "domain": config["domain"],
            "subject_name": config["artist_name"],
            "created_at": NOW - timedelta(days=random.randint(90, 365)),
            "updated_at": NOW - timedelta(days=random.randint(0, 30)),
        }
        fanclubs.append(fanclub_data)

    print(f"  [팬클럽] {len(fanclubs)}개 생성 완료")
    return fanclubs


def generate_memberships(
    user_ids: list[uuid.UUID],
    fanclubs: list[dict],
) -> list[dict[str, Any]]:
    """팬클럽 멤버십 200개 생성."""
    memberships = []
    used_pairs: set[tuple] = set()

    for i in range(NUM_MEMBERSHIPS):
        idx = i + 1

        # 유저-팬클럽 중복 방지
        while True:
            user_id = random.choice(user_ids)
            fanclub = random.choice(fanclubs)
            pair = (user_id, fanclub["id"])
            if pair not in used_pairs:
                used_pairs.add(pair)
                break

        tier = random.choices(
            [MembershipTier.BASIC.value, MembershipTier.PREMIUM.value, MembershipTier.VIP.value],
            weights=[60, 30, 10],
        )[0]

        joined_at = random_datetime(fanclub["created_at"], NOW)

        membership_data = {
            "id": uuid.uuid4(),
            "user_id": user_id,
            "fanclub_id": fanclub["id"],
            "tier": tier,
            "status": MembershipStatus.ACTIVE.value,
            "membership_code": f"FC-{uuid.uuid4().hex[:8].upper()}",
            "verified_at": joined_at + timedelta(hours=random.randint(1, 24)),
            "expires_at": joined_at + timedelta(days=365),
            "joined_at": joined_at,
        }
        memberships.append(membership_data)

        if idx % 50 == 0 or idx == NUM_MEMBERSHIPS:
            progress("멤버십 생성", idx, NUM_MEMBERSHIPS, step=50)

    return memberships


def generate_organizer_profiles(
    organizer_users: list[dict],
) -> list[dict[str, Any]]:
    """주최자 프로필 생성."""
    profiles = []
    company_suffixes = ["엔터테인먼트", "이벤츠", "컬처", "프로덕션", "기획", "에이전시", "컴퍼니"]

    for user in organizer_users:
        profile_data = {
            "id": uuid.uuid4(),
            "user_id": user["id"],
            "company_name": f"{fake.last_name()}{random.choice(company_suffixes)}",
            "business_number": f"{random.randint(100, 999)}-{random.randint(10, 99)}-{random.randint(10000, 99999)}",
            "representative_name": user["name"],
            "address": f"{user['residential_city']} {fake.road_name()} {random.randint(1, 300)}",
            "contact_phone": user["phone"],
            "contact_email": user["email"],
            "primary_domains": f'["{random.choice(["concert", "sports", "musical", "exhibition", "festival"])}"]',
            "status": OrganizerStatus.APPROVED,
            "approved_at": user["created_at"] + timedelta(days=random.randint(1, 7)),
            "created_at": user["created_at"],
            "updated_at": user["updated_at"],
        }
        profiles.append(profile_data)

    print(f"  [주최자프로필] {len(profiles)}개 생성 완료")
    return profiles


def generate_point_wallets(user_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """유저별 포인트 지갑 생성 (fan + social)."""
    wallets = []
    for user_id in user_ids:
        for pt in [PointType.FAN, PointType.SOCIAL]:
            balance = random.randint(100, 5000)
            wallets.append(
                {
                    "id": uuid.uuid4(),
                    "user_id": user_id,
                    "point_type": pt,
                    "balance": balance,
                    "lifetime_earned": balance + random.randint(0, 1000),
                    "lifetime_spent": random.randint(0, 500),
                    "created_at": NOW - timedelta(days=random.randint(30, 365)),
                    "updated_at": NOW - timedelta(days=random.randint(0, 30)),
                }
            )
    print(f"  [포인트지갑] {len(wallets)}개 생성 완료")
    return wallets


# ---------------------------------------------------------------------------
# Database operations
# ---------------------------------------------------------------------------


async def get_table_columns(conn, table_name: str) -> set[str]:
    """실제 DB에서 테이블의 컬럼 목록 조회."""
    result = await conn.execute(
        text("SELECT column_name FROM information_schema.columns WHERE table_name = :t"),
        {"t": table_name},
    )
    return {row[0] for row in result.fetchall()}


async def table_exists(conn, table_name: str) -> bool:
    """테이블 존재 여부 확인."""
    result = await conn.execute(
        text("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = :t)"),
        {"t": table_name},
    )
    return result.scalar()


def filter_data_to_columns(data_list: list[dict], db_columns: set[str]) -> list[dict]:
    """DB에 존재하는 컬럼만 남기도록 데이터 필터링."""
    if not data_list:
        return data_list
    # 첫 번째 레코드에서 제거할 키 결정
    sample_keys = set(data_list[0].keys())
    keys_to_remove = sample_keys - db_columns
    if keys_to_remove:
        print(f"    (DB에 없는 컬럼 제거: {', '.join(sorted(keys_to_remove))})")
        return [{k: v for k, v in d.items() if k in db_columns} for d in data_list]
    return data_list


async def clean_seed_data(session: AsyncSession) -> None:
    """기존 시드 데이터 삭제 (email LIKE '%@pickket.test')."""
    print("\n=== 기존 시드 데이터 삭제 중 ===")

    # 시드 유저 ID 목록 조회
    result = await session.execute(select(User.id).where(User.email.like(f"%{SEED_EMAIL_DOMAIN}")))
    seed_user_ids = [row[0] for row in result.fetchall()]

    if not seed_user_ids:
        print("  삭제할 시드 데이터 없음")
        return

    print(f"  시드 유저 {len(seed_user_ids)}명 발견")

    # reviews 테이블 존재 확인
    conn = await session.connection()
    has_reviews = await table_exists(conn, "reviews")

    # 역순으로 삭제 (외래키 의존성 순서)
    # 1. Reviews
    if has_reviews:
        del_count = await session.execute(delete(Review).where(Review.user_id.in_(seed_user_ids)))
        print(f"  리뷰 삭제: {del_count.rowcount}건")

    # 2. Point wallets
    del_count = await session.execute(
        delete(PointWallet).where(PointWallet.user_id.in_(seed_user_ids))
    )
    print(f"  포인트지갑 삭제: {del_count.rowcount}건")

    # 3. Fanclub memberships
    del_count = await session.execute(
        delete(FanclubMembership).where(FanclubMembership.user_id.in_(seed_user_ids))
    )
    print(f"  멤버십 삭제: {del_count.rowcount}건")

    # 4. Tickets (owner)
    del_count = await session.execute(
        delete(Ticket).where(Ticket.current_owner_id.in_(seed_user_ids))
    )
    print(f"  티켓 삭제: {del_count.rowcount}건")

    # 5. Orders
    del_count = await session.execute(delete(Order).where(Order.user_id.in_(seed_user_ids)))
    print(f"  주문 삭제: {del_count.rowcount}건")

    # 6. Seat tiers (이벤트 삭제 전)
    # 시드 유저가 주최한 이벤트 ID 조회
    ev_result = await session.execute(select(Event.id).where(Event.organizer_id.in_(seed_user_ids)))
    seed_event_ids = [row[0] for row in ev_result.fetchall()]

    if seed_event_ids:
        del_count = await session.execute(
            delete(SeatTier).where(SeatTier.event_id.in_(seed_event_ids))
        )
        print(f"  좌석등급 삭제: {del_count.rowcount}건")

        # 7. Events
        del_count = await session.execute(delete(Event).where(Event.id.in_(seed_event_ids)))
        print(f"  이벤트 삭제: {del_count.rowcount}건")

    # 8. Fanclubs (주최자 소유)
    del_count = await session.execute(
        delete(Fanclub).where(Fanclub.organizer_id.in_(seed_user_ids))
    )
    print(f"  팬클럽 삭제: {del_count.rowcount}건")

    # 9. Organizer profiles
    del_count = await session.execute(
        delete(OrganizerProfile).where(OrganizerProfile.user_id.in_(seed_user_ids))
    )
    print(f"  주최자프로필 삭제: {del_count.rowcount}건")

    # 10. Users (마지막)
    del_count = await session.execute(delete(User).where(User.id.in_(seed_user_ids)))
    print(f"  유저 삭제: {del_count.rowcount}건")

    await session.commit()
    print("  시드 데이터 삭제 완료!")


async def insert_batch_core(
    session: AsyncSession,
    table,
    data_list: list[dict],
    label: str,
    batch_size: int = 500,
) -> None:
    """SQLAlchemy Core __table__.insert()로 배치 삽입.

    ORM session.add() 대신 Core INSERT를 사용하여
    모델에 정의되어 있지만 DB에는 아직 마이그레이션되지 않은
    컬럼 문제를 우회한다.
    """
    total = len(data_list)
    if total == 0:
        print(f"  [{label}] 삽입할 데이터 없음")
        return

    for start in range(0, total, batch_size):
        batch = data_list[start : start + batch_size]
        await session.execute(table.insert(), batch)
        end = min(start + batch_size, total)
        if end % batch_size == 0 or end == total:
            print(f"  [{label}] {end}/{total} 삽입")


async def seed_all(session: AsyncSession) -> None:
    """모든 시드 데이터 생성 및 삽입."""
    print("\n=== Pickket 시드 데이터 생성 시작 ===\n")

    # DB 컬럼 정보 사전 로드
    conn = await session.connection()
    print("[0/9] DB 스키마 확인 중...")
    db_cols = {}
    table_map = {
        "users": User.__table__,
        "venues": Venue.__table__,
        "events": Event.__table__,
        "seat_tiers": SeatTier.__table__,
        "orders": Order.__table__,
        "tickets": Ticket.__table__,
        "reviews": Review.__table__,
        "fanclubs": Fanclub.__table__,
        "fanclub_memberships": FanclubMembership.__table__,
        "organizer_profiles": OrganizerProfile.__table__,
        "point_wallets": PointWallet.__table__,
    }
    for tbl_name in table_map:
        cols = await get_table_columns(conn, tbl_name)
        db_cols[tbl_name] = cols
        if not cols:
            print(f"  경고: {tbl_name} 테이블이 없거나 컬럼이 없습니다")
    print("  DB 스키마 확인 완료")

    has_reviews = bool(db_cols.get("reviews"))

    # 1. 비밀번호 해싱 (1회)
    print("\n[1/9] 비밀번호 해싱...")
    hashed_pw = hash_password(SEED_PASSWORD_PLAIN)
    print(f"  완료 (모든 시드 유저 비밀번호: {SEED_PASSWORD_PLAIN})")

    # 2. 유저 생성
    print(f"\n[2/9] 유저 {NUM_USERS}명 생성 중...")
    users = generate_users(hashed_pw)

    # 3. 공연장 생성
    print("\n[3/9] 공연장 데이터 생성 중...")
    venues = generate_venues()
    print(f"  공연장 {len(venues)}개 생성 완료")

    # 4. 이벤트 생성
    organizer_users = [u for u in users if u["is_organizer"]]
    organizer_ids = [u["id"] for u in organizer_users]
    print(f"\n[4/9] 이벤트 {NUM_EVENTS}개 생성 중...")
    events = generate_events(organizer_ids, venues)

    # 5. 좌석 등급 생성
    print("\n[5/9] 좌석 등급 생성 중...")
    seat_tiers = generate_seat_tiers(events)

    # 이벤트별 tier 매핑
    tiers_by_event: dict[uuid.UUID, list[dict]] = {}
    for t in seat_tiers:
        tiers_by_event.setdefault(t["event_id"], []).append(t)

    # 6. 주문 생성
    all_user_ids = [u["id"] for u in users]
    print(f"\n[6/9] 주문 {NUM_ORDERS}개 생성 중...")
    orders = generate_orders(all_user_ids, events, tiers_by_event)

    # 7. 티켓 생성
    print(f"\n[7/9] 티켓 {NUM_TICKETS}장 생성 중...")
    tickets = generate_tickets(orders, tiers_by_event)

    # 8. 리뷰 생성
    past_events = [e for e in events if e["status"] == EventStatus.COMPLETED]
    reviews = []
    if has_reviews:
        print(f"\n[8/9] 리뷰 {NUM_REVIEWS}개 생성 중...")
        reviews = generate_reviews(all_user_ids, past_events)
    else:
        print("\n[8/9] reviews 테이블 없음 — 리뷰 생성 건너뜀")

    # 9. 팬클럽 + 멤버십
    print(f"\n[9/9] 팬클럽 {NUM_FANCLUBS}개 + 멤버십 {NUM_MEMBERSHIPS}개 생성 중...")
    fanclubs = generate_fanclubs(organizer_ids)
    memberships = generate_memberships(all_user_ids, fanclubs)

    # 주최자 프로필 생성
    print("\n[추가] 주최자 프로필 생성 중...")
    organizer_profiles = generate_organizer_profiles(organizer_users)

    # 포인트 지갑 생성
    print("[추가] 포인트 지갑 생성 중...")
    point_wallets = generate_point_wallets(all_user_ids)

    # ---------------------------------------------------------------------------
    # DB 컬럼 필터링 적용
    # ---------------------------------------------------------------------------
    print("\n=== DB 컬럼 필터링 ===")
    users = filter_data_to_columns(users, db_cols["users"])
    venues = filter_data_to_columns(venues, db_cols["venues"])
    events = filter_data_to_columns(events, db_cols["events"])
    seat_tiers = filter_data_to_columns(seat_tiers, db_cols["seat_tiers"])
    orders = filter_data_to_columns(orders, db_cols["orders"])
    tickets = filter_data_to_columns(tickets, db_cols["tickets"])
    if has_reviews:
        reviews = filter_data_to_columns(reviews, db_cols["reviews"])
    fanclubs = filter_data_to_columns(fanclubs, db_cols["fanclubs"])
    memberships = filter_data_to_columns(memberships, db_cols["fanclub_memberships"])
    organizer_profiles = filter_data_to_columns(organizer_profiles, db_cols["organizer_profiles"])
    point_wallets = filter_data_to_columns(point_wallets, db_cols["point_wallets"])

    # ---------------------------------------------------------------------------
    # DB 삽입 (Core INSERT)
    # ---------------------------------------------------------------------------
    print("\n=== DB 삽입 시작 ===\n")

    # 삽입 순서: 외래키 의존성 고려
    await insert_batch_core(session, User.__table__, users, "유저")
    await insert_batch_core(session, Venue.__table__, venues, "공연장")
    await insert_batch_core(session, Event.__table__, events, "이벤트")
    await insert_batch_core(session, SeatTier.__table__, seat_tiers, "좌석등급")
    await insert_batch_core(session, Order.__table__, orders, "주문")
    await insert_batch_core(session, Ticket.__table__, tickets, "티켓")
    if has_reviews and reviews:
        await insert_batch_core(session, Review.__table__, reviews, "리뷰")
    await insert_batch_core(session, Fanclub.__table__, fanclubs, "팬클럽")
    await insert_batch_core(session, FanclubMembership.__table__, memberships, "멤버십")
    await insert_batch_core(session, OrganizerProfile.__table__, organizer_profiles, "주최자프로필")
    await insert_batch_core(
        session, PointWallet.__table__, point_wallets, "포인트지갑", batch_size=1000
    )

    # 커밋
    print("\n트랜잭션 커밋 중...")
    await session.commit()

    # ---------------------------------------------------------------------------
    # 요약
    # ---------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print("  Pickket 시드 데이터 삽입 완료!")
    print("=" * 60)
    print(f"  유저:         {len(users):,}명 (주최자 {NUM_ORGANIZERS}명, 관리자 {NUM_ADMINS}명)")
    print(f"  공연장:       {len(venues):,}개")
    print(f"  이벤트:       {len(events):,}개 (과거 30 / 진행중 20 / 미래 50)")
    print(f"  좌석등급:     {len(seat_tiers):,}개")
    print(f"  주문:         {len(orders):,}개")
    print(f"  티켓:         {len(tickets):,}장")
    if has_reviews:
        print(f"  리뷰:         {len(reviews):,}개")
    else:
        print("  리뷰:         건너뜀 (reviews 테이블 없음)")
    print(f"  팬클럽:       {len(fanclubs):,}개")
    print(f"  멤버십:       {len(memberships):,}개")
    print(f"  주최자프로필: {len(organizer_profiles):,}개")
    print(f"  포인트지갑:   {len(point_wallets):,}개")
    print(f"\n  테스트 로그인: testuser0001{SEED_EMAIL_DOMAIN} / {SEED_PASSWORD_PLAIN}")
    print(f"  관리자 로그인: testuser0001{SEED_EMAIL_DOMAIN} ~ testuser0005{SEED_EMAIL_DOMAIN}")
    print(f"  주최자 로그인: testuser0001{SEED_EMAIL_DOMAIN} ~ testuser0050{SEED_EMAIL_DOMAIN}")
    print("=" * 60)


def dry_run_report() -> None:
    """--dry-run: 실제 삽입 없이 생성할 데이터 수만 출력."""
    print("\n" + "=" * 60)
    print("  Pickket 시드 데이터 — DRY RUN (실제 삽입 없음)")
    print("=" * 60)
    print(f"  유저:         {NUM_USERS:,}명")
    print(f"    - 주최자:   {NUM_ORGANIZERS}명 (testuser0001~0050)")
    print(f"    - 관리자:   {NUM_ADMINS}명 (testuser0001~0005)")
    print(f"    - 일반:     {NUM_USERS - NUM_ORGANIZERS}명")
    print(f"  이벤트:       {NUM_EVENTS:,}개")
    print("    - 과거:     30개 (COMPLETED)")
    print("    - 진행중:   20개 (BIDDING_OPEN 등)")
    print("    - 미래:     50개 (DRAFT, APPROVED 등)")
    print(f"  좌석등급:     ~{NUM_EVENTS * 2.5:.0f}개 (이벤트당 2~3개)")
    print(f"  주문:         {NUM_ORDERS:,}개")
    print(f"    - confirmed: ~{int(NUM_ORDERS * 0.6):,}")
    print(f"    - paid:      ~{int(NUM_ORDERS * 0.2):,}")
    print(f"    - cancelled: ~{int(NUM_ORDERS * 0.1):,}")
    print(f"    - expired:   ~{int(NUM_ORDERS * 0.1):,}")
    print(f"  티켓:         {NUM_TICKETS:,}장 (confirmed/paid 주문 기반)")
    print(f"  리뷰:         {NUM_REVIEWS:,}개 (과거 이벤트 대상, 4점대 중심)")
    print(f"  팬클럽:       {NUM_FANCLUBS:,}개")
    print(f"  멤버십:       {NUM_MEMBERSHIPS:,}개")
    print(f"  주최자프로필: {NUM_ORGANIZERS}개")
    print(f"  포인트지갑:   {NUM_USERS * 2:,}개 (유저당 fan + social)")
    print(
        f"\n  이메일 패턴:  testuser0001{SEED_EMAIL_DOMAIN} ~ testuser{NUM_USERS:04d}{SEED_EMAIL_DOMAIN}"
    )
    print(f"  비밀번호:     {SEED_PASSWORD_PLAIN}")
    print(f"  DB URL:       {settings.DATABASE_URL}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main():
    parser = argparse.ArgumentParser(description="Pickket 시드 데이터 생성 스크립트")
    parser.add_argument(
        "--dry-run", action="store_true", help="실제 삽입 없이 생성할 데이터 수만 출력"
    )
    parser.add_argument(
        "--clean", action="store_true", help="기존 시드 데이터 삭제 (@pickket.test 이메일)"
    )
    parser.add_argument("--seed", action="store_true", help="--clean과 함께 사용: 삭제 후 재삽입")
    parser.add_argument(
        "--force-production", action="store_true",
        help="위험: ENVIRONMENT=production 에서도 강제 실행 (기본은 거부)",
    )
    args = parser.parse_args()

    if args.dry_run:
        dry_run_report()
        return

    # 프로덕션 보호 — 라이브 DB 에 테스트 계정/admin_role 잔재를 남기던 사고 방지(P620 감사 P2-3).
    if settings.ENVIRONMENT == "production" and not args.force_production:
        print(
            "🚫 ENVIRONMENT=production 에서는 seed 를 실행하지 않습니다 "
            "(테스트 계정/admin_role 잔재 방지). 정말 필요하면 --force-production 명시."
        )
        return

    # DB 엔진 생성
    engine = create_async_engine(
        settings.DATABASE_URL,
        echo=False,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
    )
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    print(f"DB 연결: {settings.DATABASE_URL}")
    print(f"환경: {settings.ENVIRONMENT}")

    try:
        async with session_factory() as session:
            if args.clean:
                await clean_seed_data(session)
                if not args.seed:
                    print("\n--clean 완료. 재삽입하려면 --clean --seed 사용")
                    return

            # 시드 데이터 삽입
            try:
                await seed_all(session)
            except Exception as e:
                print(f"\n!!! 오류 발생, 롤백 중: {e}")
                await session.rollback()
                raise
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
