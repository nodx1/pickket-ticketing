"""
Pickket 프로덕션 데모 시드 — 도메인별 주최자 + 16개 이벤트.

각 도메인(콘서트/뮤지컬/페스티벌/전시/스포츠/클래식)마다 전용 주최자 계정을
생성하고, 현실적인 이벤트 데이터를 투입합니다.
어드민 계정도 함께 생성합니다.

Idempotent: title 기준으로 중복 스킵.

Usage:
    cd backend && .venv/bin/python scripts/seed_demo.py
"""

from __future__ import annotations

import asyncio
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.database import async_session  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.event import Event, EventStatus, SeatTier  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.venue import Venue, VenueSection  # noqa: E402
from app.models.seat import Seat, SeatStatus  # noqa: E402

KST = ZoneInfo("Asia/Seoul")

# ---------------------------------------------------------------------------
# 계정 정보 — 도메인별 주최자 + 어드민
# ---------------------------------------------------------------------------
ADMIN_ACCOUNT = {
    "email": "admin@pickket.kr",
    "password": "PickketAdmin2026!",
    "name": "Pickket 관리자",
}

ORGANIZERS = [
    {
        "email": "concert@pickket.kr",
        "password": "Concert2026!",
        "name": "라이브네이션코리아",
        "domain": "concert",
    },
    {
        "email": "musical@pickket.kr",
        "password": "Musical2026!",
        "name": "신시컴퍼니",
        "domain": "musical",
    },
    {
        "email": "festival@pickket.kr",
        "password": "Festival2026!",
        "name": "페스티벌코리아",
        "domain": "festival",
    },
    {
        "email": "exhibition@pickket.kr",
        "password": "Exhibition2026!",
        "name": "아트플래닛",
        "domain": "exhibition",
    },
    {
        "email": "sports@pickket.kr",
        "password": "Sports2026!",
        "name": "K스포츠엔터",
        "domain": "sports",
    },
    {
        "email": "classical@pickket.kr",
        "password": "Classical2026!",
        "name": "서울아트매니지먼트",
        "domain": "classical",
    },
]

# ---------------------------------------------------------------------------
# Unsplash 이미지 (데모용 — 상업 배포 시 자체 이미지로 교체)
# ---------------------------------------------------------------------------
IMAGES = {
    "concert_1": {
        "hero": "https://images.unsplash.com/photo-1540039155733-5bb30b53aa14?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=480&h=600&fit=crop&q=80",
    },
    "concert_2": {
        "hero": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=480&h=600&fit=crop&q=80",
    },
    "concert_3": {
        "hero": "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=480&h=600&fit=crop&q=80",
    },
    "concert_4": {
        "hero": "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=480&h=600&fit=crop&q=80",
    },
    "musical_1": {
        "hero": "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?w=480&h=600&fit=crop&q=80",
    },
    "musical_2": {
        "hero": "https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=480&h=600&fit=crop&q=80",
    },
    "festival_1": {
        "hero": "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=480&h=600&fit=crop&q=80",
    },
    "festival_2": {
        "hero": "https://images.unsplash.com/photo-1506157786151-b8491531f063?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1506157786151-b8491531f063?w=480&h=600&fit=crop&q=80",
    },
    "festival_3": {
        "hero": "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?w=480&h=600&fit=crop&q=80",
    },
    "exhibition_1": {
        "hero": "https://images.unsplash.com/photo-1531243269054-5ebf6f34081e?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1531243269054-5ebf6f34081e?w=480&h=600&fit=crop&q=80",
    },
    "exhibition_2": {
        "hero": "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=480&h=600&fit=crop&q=80",
    },
    "sports_1": {
        "hero": "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1471295253337-3ceaaedca402?w=480&h=600&fit=crop&q=80",
    },
    "sports_2": {
        "hero": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=480&h=600&fit=crop&q=80",
    },
    "classical_1": {
        "hero": "https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1507838153414-b4b713384a76?w=480&h=600&fit=crop&q=80",
    },
    "classical_2": {
        "hero": "https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=1920&h=900&fit=crop&q=80",
        "poster": "https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=480&h=600&fit=crop&q=80",
    },
}

# ---------------------------------------------------------------------------
# 16개 이벤트 — MOCK_EVENTS 매칭 (8) + 추가 도메인 (8)
# ---------------------------------------------------------------------------
DEMO_EVENTS = [
    # ═══ MOCK_EVENTS 매칭 (기존 프론트엔드 UI와 1:1) ═══

    # 1. SEVENTEEN — 히어로 배너 #1
    {
        "title": "SEVENTEEN WORLD TOUR [FOLLOW] AGAIN",
        "category": "concert",
        "organizer_domain": "concert",
        "artist_name": "세븐틴",
        "description": (
            "세븐틴의 월드투어 [FOLLOW] AGAIN 서울 앙코르 공연. "
            "'MAESTRO', 'Super', 'God of Music' 등 히트곡 총출동. "
            "고척스카이돔을 가득 채울 캐럿들의 떼창이 기다립니다. "
            "Pickket 공정 배분으로 매크로 없이 동등한 기회를 제공합니다."
        ),
        "venue_name": "고척스카이돔",
        "location": "서울특별시 구로구 경인로 430",
        "location_city": "서울",
        "event_date_offset_days": 30,
        "duration_minutes": 180,
        "age_restriction": "만 7세 이상",
        "tags": "세븐틴,SVT,캐럿,월드투어,고척돔,K-POP",
        "is_featured": True,
        "image_key": "concert_1",
        "view_count": 52300,
        "bid_count": 12847,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "capacity": 3000, "seating_type": "general", "section_name": "FLOOR"},
            {"name": "지정석 R", "price": 154000, "capacity": 5000, "seating_type": "assigned", "section_name": "1F"},
            {"name": "지정석 S", "price": 121000, "capacity": 4000, "seating_type": "assigned", "section_name": "2F"},
            {"name": "VIP", "price": 176000, "capacity": 500, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },
    # 2. 빌리 엘리어트 — 히어로 배너 #2
    {
        "title": "뮤지컬 〈빌리 엘리어트〉",
        "category": "musical",
        "organizer_domain": "musical",
        "artist_name": "김우석, 박지환",
        "description": (
            "런던 웨스트엔드 오리지널 프로덕션으로 돌아온 뮤지컬 '빌리 엘리어트'. "
            "탄광촌 소년의 발레 꿈을 그린 감동 스토리와 엘튼 존의 주옥같은 넘버. "
            "'Electricity', 'Solidarity' 등 명곡을 블루스퀘어에서 만나세요."
        ),
        "venue_name": "블루스퀘어 신한카드홀",
        "location": "서울특별시 용산구 이태원로 294",
        "location_city": "서울",
        "event_date_offset_days": 3,
        "event_date_end_offset_days": 110,
        "duration_minutes": 165,
        "age_restriction": "만 8세 이상",
        "tags": "빌리엘리어트,뮤지컬,블루스퀘어,엘튼존,감동",
        "is_featured": True,
        "image_key": "musical_1",
        "view_count": 28400,
        "bid_count": 3421,
        "tiers": [
            {"name": "VIP석", "price": 170000, "capacity": 200, "seating_type": "assigned", "section_name": "1F 중앙"},
            {"name": "R석", "price": 140000, "capacity": 600, "seating_type": "assigned", "section_name": "1F"},
            {"name": "S석", "price": 100000, "capacity": 500, "seating_type": "assigned", "section_name": "2F 앞"},
            {"name": "A석", "price": 70000, "capacity": 700, "seating_type": "assigned", "section_name": "2F 뒤"},
        ],
    },
    # 3. 서울재즈페스티벌 — 히어로 배너 #3
    {
        "title": "2026 서울재즈페스티벌",
        "category": "festival",
        "organizer_domain": "festival",
        "artist_name": "다양한 아티스트",
        "description": (
            "올림픽공원 잔디광장에서 3일간 펼쳐지는 국내 최대 재즈 페스티벌. "
            "해외 헤드라이너와 국내 재즈 뮤지션 40팀 이상 출연. "
            "잔디밭에서 맥주와 함께 즐기는 여유로운 음악 축제."
        ),
        "venue_name": "올림픽공원",
        "location": "서울특별시 송파구 올림픽로 424",
        "location_city": "서울",
        "event_date_offset_days": 72,
        "event_date_end_offset_days": 74,
        "duration_minutes": 600,
        "age_restriction": "전체 관람가",
        "tags": "재즈,페스티벌,올림픽공원,야외,음악축제",
        "is_featured": True,
        "image_key": "festival_1",
        "view_count": 41200,
        "bid_count": 8932,
        "tiers": [
            {"name": "1일권", "price": 99000, "capacity": 5000, "seating_type": "general"},
            {"name": "3일 통합권", "price": 250000, "capacity": 3000, "seating_type": "general"},
            {"name": "VIP 라운지 (1일)", "price": 180000, "capacity": 200, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },
    # 4. 아이브 — 수요 폭발 이벤트
    {
        "title": "아이브 THE 1ST WORLD TOUR",
        "category": "concert",
        "organizer_domain": "concert",
        "artist_name": "IVE",
        "description": (
            "아이브의 첫 번째 월드투어 서울 공연. 'LOVE DIVE', 'After LIKE', "
            "'Kitsch', 'Baddie' 등 차트 올킬 곡들을 KSPO DOME에서 라이브로. "
            "6인 6색 퍼포먼스와 화려한 스테이지를 놓치지 마세요."
        ),
        "venue_name": "KSPO DOME",
        "location": "서울특별시 송파구 올림픽로 424",
        "location_city": "서울",
        "event_date_offset_days": 44,
        "duration_minutes": 180,
        "age_restriction": "만 7세 이상",
        "tags": "아이브,IVE,다이브,월드투어,KSPO,K-POP",
        "is_featured": False,
        "image_key": "concert_2",
        "view_count": 67800,
        "bid_count": 18234,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "capacity": 3000, "seating_type": "general", "section_name": "FLOOR"},
            {"name": "지정석 R", "price": 143000, "capacity": 4000, "seating_type": "assigned", "section_name": "1F"},
            {"name": "지정석 S", "price": 110000, "capacity": 3000, "seating_type": "assigned", "section_name": "2F"},
            {"name": "VIP", "price": 198000, "capacity": 500, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },
    # 5. 오페라의 유령
    {
        "title": "뮤지컬 〈오페라의 유령〉",
        "category": "musical",
        "organizer_domain": "musical",
        "artist_name": "조승우, 전동석",
        "description": (
            "앤드루 로이드 웨버의 불멸의 명작 '오페라의 유령' 25주년 내한. "
            "샹들리에가 떨어지는 전설의 장면부터 'The Music of the Night'까지. "
            "샤롯데씨어터의 완벽한 음향으로 다시 만나는 오페라 유령."
        ),
        "venue_name": "샤롯데씨어터",
        "location": "서울특별시 송파구 올림픽로 240",
        "location_city": "서울",
        "event_date_offset_days": 19,
        "event_date_end_offset_days": 140,
        "duration_minutes": 165,
        "age_restriction": "만 8세 이상",
        "tags": "오페라유령,뮤지컬,조승우,샤롯데씨어터,클래식",
        "is_featured": False,
        "image_key": "musical_2",
        "view_count": 35600,
        "bid_count": 2100,
        "tiers": [
            {"name": "VIP석", "price": 180000, "capacity": 150, "seating_type": "assigned", "section_name": "1F 중앙"},
            {"name": "R석", "price": 140000, "capacity": 400, "seating_type": "assigned", "section_name": "1F"},
            {"name": "S석", "price": 100000, "capacity": 350, "seating_type": "assigned", "section_name": "2F 앞"},
            {"name": "A석", "price": 60000, "capacity": 500, "seating_type": "assigned", "section_name": "2F 뒤"},
        ],
    },
    # 6. 모네에서 워홀까지
    {
        "title": "모네에서 워홀까지: 빛과 색의 혁명",
        "category": "exhibition",
        "organizer_domain": "exhibition",
        "description": (
            "인상주의부터 팝아트까지, 서양 미술사 150년을 원작 120점으로 조망. "
            "모네의 '수련', 고흐의 '별이 빛나는 밤', 워홀의 '캠벨 수프' 등 "
            "해외 15개 미술관 소장 걸작을 예술의전당에서 만나세요."
        ),
        "venue_name": "예술의전당 한가람미술관",
        "location": "서울특별시 서초구 남부순환로 2406",
        "location_city": "서울",
        "event_date_offset_days": 8,
        "event_date_end_offset_days": 155,
        "duration_minutes": 120,
        "age_restriction": "전체 관람가",
        "tags": "모네,워홀,고흐,현대미술,예술의전당,전시",
        "is_featured": False,
        "image_key": "exhibition_1",
        "view_count": 22300,
        "bid_count": 890,
        "tiers": [
            {"name": "일반 관람권", "price": 18000, "capacity": 500, "seating_type": "general"},
            {"name": "도슨트 투어", "price": 30000, "capacity": 150, "seating_type": "general"},
            {"name": "VIP 나이트", "price": 45000, "capacity": 100, "seating_type": "general"},
        ],
    },
    # 7. DAY6
    {
        "title": "DAY6 CONCERT 2026",
        "category": "concert",
        "organizer_domain": "concert",
        "artist_name": "DAY6",
        "description": (
            "데이식스 2026 단독 콘서트. '예뻤어', '한 페이지가 될 수 있게', "
            "'Welcome to the Show' 등 밴드 사운드 가득한 라이브. "
            "올림픽체조경기장에서 펼쳐지는 떼창의 향연!"
        ),
        "venue_name": "올림픽체조경기장",
        "location": "서울특별시 송파구 올림픽로 424",
        "location_city": "서울",
        "event_date_offset_days": 58,
        "duration_minutes": 180,
        "age_restriction": "만 7세 이상",
        "tags": "DAY6,데이식스,밴드,JYP,떼창,콘서트",
        "is_featured": False,
        "image_key": "concert_3",
        "view_count": 38700,
        "bid_count": 9500,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "capacity": 3000, "seating_type": "general", "section_name": "FLOOR"},
            {"name": "지정석 R", "price": 143000, "capacity": 4000, "seating_type": "assigned", "section_name": "1F"},
            {"name": "지정석 S", "price": 110000, "capacity": 3000, "seating_type": "assigned", "section_name": "2F"},
        ],
    },
    # 8. 르세라핌
    {
        "title": "르세라핌 FLAME RISES TOUR",
        "category": "concert",
        "organizer_domain": "concert",
        "artist_name": "LE SSERAFIM",
        "description": (
            "르세라핌의 첫 월드투어 FLAME RISES 서울 공연. "
            "'FEARLESS', 'UNFORGIVEN', 'Perfect Night' 등 "
            "잠실실내체육관을 불태울 퍼포먼스를 만나세요."
        ),
        "venue_name": "잠실실내체육관",
        "location": "서울특별시 송파구 올림픽로 25",
        "location_city": "서울",
        "event_date_offset_days": 86,
        "duration_minutes": 180,
        "age_restriction": "만 7세 이상",
        "tags": "르세라핌,LESSERAFIM,하이브,월드투어,잠실",
        "is_featured": False,
        "image_key": "concert_4",
        "view_count": 58900,
        "bid_count": 15200,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "capacity": 2500, "seating_type": "general", "section_name": "FLOOR"},
            {"name": "지정석 R", "price": 148000, "capacity": 3500, "seating_type": "assigned", "section_name": "1F"},
            {"name": "지정석 S", "price": 121000, "capacity": 3000, "seating_type": "assigned", "section_name": "2F"},
            {"name": "VIP", "price": 165000, "capacity": 500, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },

    # ═══ 추가 이벤트 — 각 도메인 채우기 ═══

    # 9. 에스파 — 콘서트 추가
    {
        "title": "aespa LIVE TOUR 'SYNK : PARALLEL LINE' in SEOUL",
        "category": "concert",
        "organizer_domain": "concert",
        "artist_name": "aespa",
        "description": (
            "에스파의 세 번째 월드투어 서울 공연. 'Supernova', 'Whip It', 'Armageddon' 등 "
            "히트곡 총망라와 함께 최첨단 XR 스테이지를 선보입니다."
        ),
        "venue_name": "KSPO DOME (올림픽 체조경기장)",
        "location": "서울특별시 송파구 올림픽로 424",
        "location_city": "서울",
        "event_date_offset_days": 35,
        "duration_minutes": 180,
        "age_restriction": "만 7세 이상",
        "tags": "에스파,aespa,SM,MY,월드투어,K-POP",
        "is_featured": False,
        "image_key": "concert_2",
        "view_count": 45200,
        "bid_count": 12800,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "capacity": 3000, "seating_type": "general", "section_name": "FLOOR"},
            {"name": "지정석 R", "price": 154000, "capacity": 4000, "seating_type": "assigned", "section_name": "1F"},
            {"name": "지정석 S", "price": 121000, "capacity": 3000, "seating_type": "assigned", "section_name": "2F"},
            {"name": "VIP", "price": 220000, "capacity": 500, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },
    # 10. 레미제라블 — 뮤지컬 추가
    {
        "title": "뮤지컬 '레미제라블' 내한공연 — 오리지널 런던 캐스트",
        "category": "musical",
        "organizer_domain": "musical",
        "artist_name": "오리지널 런던 웨스트엔드 캐스트",
        "description": (
            "세계 4대 뮤지컬 '레미제라블' 오리지널 런던 캐스트가 서울에 옵니다. "
            "'One Day More', 'I Dreamed a Dream' 등 불멸의 넘버를 "
            "충무아트센터 대극장 라이브 오케스트라와 함께."
        ),
        "venue_name": "충무아트센터 대극장",
        "location": "서울특별시 중구 퇴계로 387",
        "location_city": "서울",
        "event_date_offset_days": 25,
        "event_date_end_offset_days": 85,
        "duration_minutes": 170,
        "age_restriction": "만 8세 이상",
        "tags": "레미제라블,뮤지컬,웨스트엔드,충무아트센터,내한",
        "is_featured": False,
        "image_key": "musical_1",
        "view_count": 38400,
        "bid_count": 9200,
        "tiers": [
            {"name": "VIP석", "price": 190000, "capacity": 200, "seating_type": "assigned", "section_name": "1F 중앙"},
            {"name": "R석", "price": 160000, "capacity": 400, "seating_type": "assigned", "section_name": "1F"},
            {"name": "S석", "price": 130000, "capacity": 300, "seating_type": "assigned", "section_name": "2F 앞"},
            {"name": "A석", "price": 90000, "capacity": 400, "seating_type": "assigned", "section_name": "2F 뒤"},
        ],
    },
    # 11. KBO 올스타전 — 스포츠
    {
        "title": "2026 KBO 올스타전",
        "category": "sports",
        "organizer_domain": "sports",
        "description": (
            "KBO리그 올스타들의 축제. 팬 투표 1위 선수들의 드림 라인업과 "
            "홈런 더비가 한화생명이글스파크에서 펼쳐집니다."
        ),
        "venue_name": "한화생명이글스파크",
        "location": "대전광역시 중구 대종로 373",
        "location_city": "대전",
        "event_date_offset_days": 80,
        "duration_minutes": 240,
        "age_restriction": "전체 관람가",
        "tags": "KBO,올스타전,야구,대전,홈런더비",
        "is_featured": False,
        "image_key": "sports_1",
        "view_count": 22500,
        "bid_count": 6700,
        "tiers": [
            {"name": "익사이팅석", "price": 40000, "capacity": 3000, "seating_type": "assigned", "section_name": "내야"},
            {"name": "중앙지정석", "price": 30000, "capacity": 5000, "seating_type": "assigned", "section_name": "내야"},
            {"name": "외야자유석", "price": 15000, "capacity": 8000, "seating_type": "general", "section_name": "외야"},
            {"name": "테이블석 (4인)", "price": 120000, "capacity": 200, "seating_type": "assigned", "section_name": "스카이박스"},
        ],
    },
    # 12. K리그 슈퍼매치 — 스포츠
    {
        "title": "2026 K리그 슈퍼매치 — FC서울 vs 수원FC",
        "category": "sports",
        "organizer_domain": "sports",
        "description": (
            "대한민국 축구의 뜨거운 라이벌리. "
            "서울월드컵경기장에서 벌어지는 FC서울과 수원FC의 한판 승부."
        ),
        "venue_name": "서울월드컵경기장",
        "location": "서울특별시 마포구 월드컵로 240",
        "location_city": "서울",
        "event_date_offset_days": 20,
        "duration_minutes": 150,
        "age_restriction": "전체 관람가",
        "tags": "K리그,축구,FC서울,슈퍼매치,월드컵경기장",
        "is_featured": False,
        "image_key": "sports_2",
        "view_count": 15300,
        "bid_count": 4100,
        "tiers": [
            {"name": "W석 (중앙)", "price": 25000, "capacity": 8000, "seating_type": "assigned", "section_name": "W석"},
            {"name": "E석 (원정)", "price": 18000, "capacity": 10000, "seating_type": "assigned", "section_name": "E석"},
            {"name": "N석 (서포터)", "price": 12000, "capacity": 15000, "seating_type": "general", "section_name": "N석"},
            {"name": "S석 (가족)", "price": 15000, "capacity": 10000, "seating_type": "assigned", "section_name": "S석"},
        ],
    },
    # 13. 조성진 클래식
    {
        "title": "서울시향 x 조성진 — 라흐마니노프 피아노 협주곡 2번",
        "category": "classical",
        "organizer_domain": "classical",
        "artist_name": "조성진 (피아노), 오스모 벤스케 (지휘)",
        "description": (
            "세계적인 피아니스트 조성진과 서울시립교향악단의 특별 협연. "
            "라흐마니노프 피아노 협주곡 2번과 차이콥스키 교향곡 5번."
        ),
        "venue_name": "예술의전당 콘서트홀",
        "location": "서울특별시 서초구 남부순환로 2406",
        "location_city": "서울",
        "event_date_offset_days": 18,
        "duration_minutes": 120,
        "age_restriction": "만 8세 이상",
        "tags": "조성진,서울시향,라흐마니노프,클래식,예술의전당",
        "is_featured": False,
        "image_key": "classical_1",
        "view_count": 8900,
        "bid_count": 2100,
        "tiers": [
            {"name": "R석", "price": 150000, "capacity": 400, "seating_type": "assigned", "section_name": "1F 중앙"},
            {"name": "S석", "price": 100000, "capacity": 600, "seating_type": "assigned", "section_name": "1F 좌우"},
            {"name": "A석", "price": 70000, "capacity": 500, "seating_type": "assigned", "section_name": "2F"},
            {"name": "B석", "price": 40000, "capacity": 700, "seating_type": "assigned", "section_name": "3F"},
        ],
    },
    # 14. 부산 불꽃축제 — 페스티벌 추가
    {
        "title": "2026 부산 국제 불꽃축제",
        "category": "festival",
        "organizer_domain": "festival",
        "description": (
            "광안대교를 배경으로 펼쳐지는 아시아 최대 규모 멀티미디어 불꽃쇼. "
            "3개국 팀의 경쟁 불꽃과 레이저, 드론 쇼가 광안리 밤하늘을 수놓습니다."
        ),
        "venue_name": "광안리 해수욕장",
        "location": "부산광역시 수영구 광안해변로 219",
        "location_city": "부산",
        "event_date_offset_days": 65,
        "duration_minutes": 300,
        "age_restriction": "전체 관람가",
        "tags": "불꽃축제,부산,광안리,드론쇼,해변",
        "is_public_sector": True,
        "is_featured": False,
        "image_key": "festival_2",
        "view_count": 31200,
        "bid_count": 7600,
        "tiers": [
            {"name": "일반 관람 (해변 자유)", "price": 0, "capacity": 50000, "seating_type": "general"},
            {"name": "프리미엄 비치 시트 (2인)", "price": 80000, "capacity": 1000, "seating_type": "assigned", "section_name": "프리미엄존"},
            {"name": "스카이라운지 (4인)", "price": 200000, "capacity": 100, "seating_type": "assigned", "section_name": "라운지"},
        ],
    },
    # 15. 반 고흐 전시 — 전시 추가
    {
        "title": "빈센트 반 고흐: 별이 빛나는 밤에",
        "category": "exhibition",
        "organizer_domain": "exhibition",
        "description": (
            "반 고흐의 걸작을 몰입형 미디어아트로 재해석한 대형 전시. "
            "360도 프로젝션 맵핑으로 '별이 빛나는 밤', '해바라기', '아를의 방'을 "
            "온몸으로 체험하세요. 서울 DDP 특별전."
        ),
        "venue_name": "DDP (동대문디자인플라자)",
        "location": "서울특별시 중구 을지로 281",
        "location_city": "서울",
        "event_date_offset_days": 5,
        "event_date_end_offset_days": 120,
        "duration_minutes": 90,
        "age_restriction": "전체 관람가",
        "tags": "반고흐,미디어아트,DDP,전시,별이빛나는밤",
        "is_featured": False,
        "image_key": "exhibition_2",
        "view_count": 19800,
        "bid_count": 1650,
        "tiers": [
            {"name": "일반 관람권", "price": 20000, "capacity": 400, "seating_type": "general"},
            {"name": "프리미엄 (음료 포함)", "price": 35000, "capacity": 100, "seating_type": "general"},
        ],
    },
    # 16. 서울숲 클래식 — 클래식 추가
    {
        "title": "서울숲 별빛 클래식 — 여름 밤의 세레나데",
        "category": "classical",
        "organizer_domain": "classical",
        "artist_name": "코리안챔버오케스트라",
        "description": (
            "서울숲 잔디광장에서 열리는 야외 클래식 공연. "
            "모차르트, 비발디, 엘가의 명곡을 여름 밤에. "
            "돗자리와 와인을 가져와 세레나데를 즐겨보세요."
        ),
        "venue_name": "서울숲 잔디광장 특설무대",
        "location": "서울특별시 성동구 뚝섬로 273",
        "location_city": "서울",
        "event_date_offset_days": 45,
        "duration_minutes": 120,
        "age_restriction": "전체 관람가",
        "tags": "야외클래식,서울숲,세레나데,피크닉,여름",
        "is_featured": False,
        "image_key": "classical_2",
        "view_count": 6500,
        "bid_count": 1400,
        "tiers": [
            {"name": "잔디석 (자유)", "price": 30000, "capacity": 1200, "seating_type": "general"},
            {"name": "의자석 (지정)", "price": 55000, "capacity": 400, "seating_type": "assigned", "section_name": "중앙"},
            {"name": "프리미엄 피크닉 (2인, 와인 포함)", "price": 120000, "capacity": 50, "seating_type": "assigned", "section_name": "VIP"},
        ],
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def get_or_create_user(
    session, *, email: str, password: str, name: str,
    is_organizer: bool = False, is_admin: bool = False,
) -> User:
    """Return existing user or create a new one."""
    result = await session.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user:
        user.is_organizer = user.is_organizer or is_organizer
        user.is_admin = user.is_admin or is_admin
        user.is_verified = True
        user.is_active = True
        return user

    user = User(
        email=email,
        hashed_password=hash_password(password),
        name=name,
        is_organizer=is_organizer,
        is_admin=is_admin,
        is_verified=True,
        is_active=True,
        preferred_language="ko",
        timezone="Asia/Seoul",
    )
    if is_admin:
        user.admin_role = "super_admin"
    session.add(user)
    await session.flush()
    return user


async def get_or_create_venue(
    session, *, name: str, address: str, total_capacity: int
) -> Venue:
    """Return existing venue or create a new one."""
    city = address.split()[0] if address else ""
    result = await session.execute(select(Venue).where(Venue.name == name).limit(1))
    venue = result.scalar_one_or_none()
    if venue:
        venue.total_capacity = max(venue.total_capacity, total_capacity)
        return venue

    venue = Venue(name=name, city=city, address=address, total_capacity=total_capacity)
    session.add(venue)
    await session.flush()
    return venue


# ---------------------------------------------------------------------------
# Main seed logic
# ---------------------------------------------------------------------------

async def seed() -> dict:
    """Seed all demo data. Returns summary stats."""
    now = datetime.now(KST)
    stats = {"admin": 0, "organizers": 0, "events_created": 0, "events_skipped": 0}

    async with async_session() as session:
        # ── 1. 어드민 계정 ──
        admin = await get_or_create_user(
            session,
            email=ADMIN_ACCOUNT["email"],
            password=ADMIN_ACCOUNT["password"],
            name=ADMIN_ACCOUNT["name"],
            is_admin=True,
        )
        stats["admin"] = 1
        print(f"  ✓ 어드민: {admin.email}")

        # ── 2. 도메인별 주최자 계정 ──
        organizer_map: dict[str, User] = {}
        for org_info in ORGANIZERS:
            org = await get_or_create_user(
                session,
                email=org_info["email"],
                password=org_info["password"],
                name=org_info["name"],
                is_organizer=True,
            )
            organizer_map[org_info["domain"]] = org
            stats["organizers"] += 1
            print(f"  ✓ 주최자 [{org_info['domain']}]: {org.email} ({org.name})")

        # ── 3. 이벤트 시드 ──
        for item in DEMO_EVENTS:
            # 중복 체크
            existing = await session.execute(
                select(Event).where(Event.title == item["title"])
            )
            if existing.scalar_one_or_none():
                stats["events_skipped"] += 1
                continue

            # 주최자 매핑
            domain = item.get("organizer_domain", "concert")
            organizer = organizer_map.get(domain, list(organizer_map.values())[0])

            # 가격/좌석 계산
            total_capacity = sum(t["capacity"] for t in item["tiers"])
            prices = [t["price"] for t in item["tiers"] if t["price"] > 0]
            min_price = min(prices) if prices else 0
            max_price = max(prices) if prices else 0

            # 날짜 계산
            event_date = now + timedelta(days=item["event_date_offset_days"])
            event_date_end = None
            if "event_date_end_offset_days" in item:
                event_date_end = now + timedelta(days=item["event_date_end_offset_days"])

            bidding_opens_at = now - timedelta(days=random.randint(1, 5))
            bidding_closes_at = event_date - timedelta(days=7)
            if bidding_closes_at <= bidding_opens_at:
                bidding_closes_at = now + timedelta(days=7)

            # 장소
            venue = await get_or_create_venue(
                session,
                name=item["venue_name"],
                address=item["location"],
                total_capacity=total_capacity,
            )

            # 이미지 URL
            img = IMAGES.get(item.get("image_key", ""), {})
            image_url = img.get("hero")
            thumbnail_url = img.get("poster")

            import re as _re
            _slug_base = _re.sub(r"[^a-z0-9]+", "-", item["title"].lower()).strip("-")[:60]
            import uuid as _uuid_mod
            _slug = f"{_slug_base}-{str(_uuid_mod.uuid4())[:8]}"

            event = Event(
                organizer_id=organizer.id,
                title=item["title"],
                slug=_slug,
                description=item.get("description", ""),
                venue=item["venue_name"],
                venue_id=venue.id,
                event_date=event_date,
                event_date_end=event_date_end,
                bidding_opens_at=bidding_opens_at,
                bidding_closes_at=bidding_closes_at,
                total_seats=total_capacity,
                min_price=min_price,
                max_price=max_price if max_price > 0 else None,
                category=item["category"],
                status=EventStatus.BIDDING_OPEN,
                is_featured=item.get("is_featured", False),
                location_city=item.get("location_city", ""),
                is_public_sector=item.get("is_public_sector", False),
                is_free=item.get("is_free", False),
                artist_name=item.get("artist_name"),
                age_restriction=item.get("age_restriction"),
                tags=item.get("tags"),
                duration_minutes=item.get("duration_minutes"),
                image_url=image_url,
                thumbnail_url=thumbnail_url,
                view_count=item.get("view_count", 0),
                bid_count=item.get("bid_count", 0),
            )
            session.add(event)
            await session.flush()

            # 좌석 티어
            for tier_item in item["tiers"]:
                sold = random.randint(
                    int(tier_item["capacity"] * 0.15),
                    int(tier_item["capacity"] * 0.55),
                )
                session.add(
                    SeatTier(
                        event_id=event.id,
                        name=tier_item["name"],
                        capacity=tier_item["capacity"],
                        base_price=float(tier_item["price"]),
                        face_price=float(tier_item["price"]),
                        sale_mode="fixed_fcfs",
                        seating_type=tier_item.get("seating_type", "general"),
                        section_name=tier_item.get("section_name"),
                        sold_count=sold,
                    )
                )

            stats["events_created"] += 1
            print(f"  ✓ 이벤트: [{item['category']}] {item['title']}")

        await session.commit()

    return stats


async def main() -> None:
    # 프로덕션 보호(P620 감사 P2-3) — 라이브 DB 에 데모/테스트 계정 잔재 방지.
    import os
    from app.core.config import settings
    if settings.ENVIRONMENT == "production" and os.environ.get("SEED_ALLOW_PRODUCTION") != "1":
        print("🚫 ENVIRONMENT=production 에서는 데모 시드를 실행하지 않습니다 "
              "(테스트/데모 계정 잔재 방지). 정말 필요하면 SEED_ALLOW_PRODUCTION=1 로 실행.")
        return
    print(f"\n{'='*50}")
    print("  Pickket 프로덕션 데모 시드")
    print(f"{'='*50}\n")

    stats = await seed()

    print(f"\n{'='*50}")
    print(f"  완료!")
    print(f"{'='*50}")
    print(f"  어드민: {stats['admin']}명 (admin@pickket.kr)")
    print(f"  주최자: {stats['organizers']}명 (도메인별)")
    print(f"  이벤트 생성: {stats['events_created']}건")
    if stats["events_skipped"]:
        print(f"  이벤트 스킵: {stats['events_skipped']}건 (이미 존재)")
    print(f"  전체 정의: {len(DEMO_EVENTS)}건")
    print(f"{'='*50}")
    print("\n  주최자 로그인 정보:")
    for org in ORGANIZERS:
        print(f"    {org['domain']:12s} → {org['email']} / {org['password']}")
    print(f"    {'admin':12s} → {ADMIN_ACCOUNT['email']} / {ADMIN_ACCOUNT['password']}")
    print()


###############################################################################
# ── 좌석 시드 (특정 이벤트에 venue section + 좌석 생성) ─────────────────────
###############################################################################

SEAT_TARGETS = [
    {"title_contains": "아이브", "sale_mode_override": None, "sold_ratio": 0.25},
    {"title_contains": "SEVENTEEN", "sale_mode_override": "lottery", "sold_ratio": 0.35},
]

SECTION_DEFS = [
    # VIP: 무대 바로 앞 센터
    {"name": "VIP", "seating": "assigned", "rows": 5, "cols": 20, "cap": 100, "color": "#7B61FF",
     "svg": "M270,140 L530,140 L530,250 L270,250 Z", "cx": 400, "cy": 195},
    # S석: 왼쪽
    {"name": "S석", "seating": "assigned", "rows": 10, "cols": 16, "cap": 160, "color": "#01f5a0",
     "svg": "M20,140 L240,140 L240,390 L20,390 Z", "cx": 130, "cy": 265},
    # R석: 오른쪽
    {"name": "R석", "seating": "assigned", "rows": 10, "cols": 16, "cap": 160, "color": "#FFD700",
     "svg": "M560,140 L780,140 L780,390 L560,390 Z", "cx": 670, "cy": 265},
    # 스탠딩: VIP 뒤 센터
    {"name": "스탠딩", "seating": "general", "rows": 0, "cols": 0, "cap": 300, "color": "#00D1FF",
     "svg": "M270,270 L530,270 L530,390 L270,390 Z", "cx": 400, "cy": 330},
]


async def ensure_enum_values():
    """DB enum에 누락된 값 추가 (마이그레이션 순서 문제 방지)."""
    from sqlalchemy import text
    async with async_session() as session:
        additions = [
            ("point_tx_type_enum", [
                "invest_lottery", "refund_lottery", "earn_consolation_lottery",
                "earn_invite", "earn_quest", "earn_streak",
                "earn_purchase", "earn_goods", "deduct_shop",
            ]),
        ]
        for type_name, values in additions:
            for val in values:
                try:
                    await session.execute(text(
                        f"ALTER TYPE {type_name} ADD VALUE IF NOT EXISTS '{val}'"
                    ))
                    await session.commit()
                except Exception:
                    await session.rollback()
        print("  ✓ enum 값 보정 완료")


async def seed_seats():
    """모든 이벤트에 venue section + 좌석 데이터 생성."""
    import uuid
    from sqlalchemy import delete

    async with async_session() as session:
        # 전체 이벤트 가져오기
        all_events_result = await session.execute(select(Event))
        all_events = all_events_result.scalars().all()

        for event in all_events:
            # 이미 좌석 있으면 스킵
            seat_check = await session.execute(
                select(Seat.id).where(Seat.event_id == event.id).limit(1)
            )
            if seat_check.scalar_one_or_none():
                print(f"  ⏭ '{event.title[:30]}' 좌석 이미 있음 — 스킵")
                continue

            venue_id = event.venue_id
            if not venue_id:
                print(f"  ⚠ '{event.title[:30]}' venue_id 없음 — 좌석 스킵")
                continue

            # 기존 venue section 삭제 후 재생성
            await session.execute(delete(VenueSection).where(VenueSection.venue_id == venue_id))

            # tier 가져오기
            tier_result = await session.execute(
                select(SeatTier).where(SeatTier.event_id == event.id)
            )
            tiers = {t.name: t for t in tier_result.scalars().all()}

            # tier가 없으면 기본 4개 생성
            if not tiers:
                from app.models.event import SeatTier as SeatTierModel
                default_tiers = [
                    {"name": "VIP", "base_price": 150000, "face_price": 150000, "seating_type": "assigned"},
                    {"name": "지정석 S", "base_price": 110000, "face_price": 110000, "seating_type": "assigned"},
                    {"name": "지정석 R", "base_price": 80000, "face_price": 80000, "seating_type": "assigned"},
                    {"name": "스탠딩", "base_price": 50000, "face_price": 50000, "seating_type": "general"},
                ]
                for i, dt in enumerate(default_tiers):
                    tier = SeatTierModel(
                        id=uuid.uuid4(),
                        event_id=event.id,
                        name=dt["name"],
                        capacity=500,
                        base_price=dt["base_price"],
                        face_price=dt["face_price"],
                        seating_type=dt["seating_type"],
                        sale_mode="fixed_fcfs",
                    )
                    session.add(tier)
                    tiers[dt["name"]] = tier
                await session.flush()

            # sold_count 리셋
            for t in tiers.values():
                t.sold_count = 0

            # 기존 tier를 section에 매핑 (키워드 매칭)
            def find_tier_for_section(sec_name, tiers_dict):
                """tier 이름에서 키워드로 section 매칭."""
                name_lower_map = {k.lower(): v for k, v in tiers_dict.items()}
                if sec_name == "VIP":
                    for k, v in name_lower_map.items():
                        if "vip" in k:
                            return v
                elif sec_name == "S석":
                    for k, v in name_lower_map.items():
                        if ("s석" in k or "지정석 s" in k.lower()) and "vip" not in k:
                            return v
                elif sec_name == "R석":
                    for k, v in name_lower_map.items():
                        if ("r석" in k or "지정석 r" in k.lower() or "a석" in k) and "vip" not in k:
                            return v
                elif sec_name == "스탠딩":
                    for k, v in name_lower_map.items():
                        if "스탠딩" in k or "일권" in k or "통합" in k or "자유석" in k:
                            return v
                return None

            sold_ratio = 0.0  # 데모용: 매진 좌석 없음

            # tier가 4개 미만이면 부족한 것 생성
            needed_sections = ["VIP", "S석", "R석", "스탠딩"]
            for sec_name in needed_sections:
                if not find_tier_for_section(sec_name, tiers):
                    from app.models.event import SeatTier as SeatTierModel
                    defaults = {"VIP": 150000, "S석": 110000, "R석": 80000, "스탠딩": 50000}
                    tier_names = {"VIP": "VIP", "S석": "지정석 S", "R석": "지정석 R", "스탠딩": "스탠딩"}
                    seating = "general" if sec_name == "스탠딩" else "assigned"
                    new_tier = SeatTierModel(
                        id=uuid.uuid4(),
                        event_id=event.id,
                        name=tier_names[sec_name],
                        capacity=500,
                        base_price=defaults[sec_name],
                        face_price=defaults[sec_name],
                        seating_type=seating,
                        sale_mode="fixed_fcfs",
                    )
                    session.add(new_tier)
                    tiers[tier_names[sec_name]] = new_tier
            await session.flush()

            for sec_def in SECTION_DEFS:
                # VenueSection 생성
                section = VenueSection(
                    id=uuid.uuid4(),
                    venue_id=venue_id,
                    name=sec_def["name"],
                    label=sec_def["name"],
                    capacity=sec_def["cap"],
                    svg_path=sec_def["svg"],
                    center_x=sec_def["cx"],
                    center_y=sec_def["cy"],
                    floor=1,
                    color=sec_def["color"],
                )
                session.add(section)

                # 매칭되는 tier 찾기
                matched_tier = find_tier_for_section(sec_def["name"], tiers)

                if not matched_tier:
                    continue

                # tier capacity 업데이트
                matched_tier.capacity = sec_def["cap"]
                matched_tier.seating_type = sec_def["seating"]

                # 좌석 생성 (assigned만)
                if sec_def["seating"] != "assigned":
                    continue

                for row in range(1, sec_def["rows"] + 1):
                    for col in range(1, sec_def["cols"] + 1):
                        is_sold = random.random() < sold_ratio
                        row_score = max(0, 1 - (row - 1) / sec_def["rows"])
                        center = sec_def["cols"] / 2
                        center_score = max(0, 1 - abs(col - center) / center)
                        quality = round(row_score * 0.6 + center_score * 0.4, 2)

                        seat = Seat(
                            id=uuid.uuid4(),
                            event_id=event.id,
                            tier_id=matched_tier.id,
                            section=sec_def["name"],
                            row_number=row,
                            seat_number=col,
                            label=f"{sec_def['name']} {row}열 {col}번",
                            x=col * 18,
                            y=row * 18,
                            status=SeatStatus.SOLD if is_sold else SeatStatus.AVAILABLE,
                            quality_score=quality,
                            is_obstructed=False,
                        )
                        session.add(seat)

            await session.flush()

            # sold_count 업데이트
            for t in tiers.values():
                sold_result = await session.execute(
                    select(Seat.id).where(
                        Seat.tier_id == t.id,
                        Seat.status == SeatStatus.SOLD,
                    )
                )
                t.sold_count = len(sold_result.all())

            await session.commit()
            print(f"  ✓ '{event.title[:30]}' 좌석 생성 완료")

    print()


async def seed_quests():
    """Seed daily and weekly quest definitions (idempotent by title)."""
    from app.models.quest import Quest, QuestType

    quests_data = [
        # Daily quests
        {
            "quest_type": QuestType.DAILY,
            "title": "댓글 남기기",
            "description": "이벤트에 댓글을 1개 남기세요",
            "ap_reward": 10,
            "condition_type": "comment",
            "condition_count": 1,
            "is_active": True,
        },
        {
            "quest_type": QuestType.DAILY,
            "title": "이벤트 3개 둘러보기",
            "description": "이벤트 상세 페이지를 3개 방문하세요",
            "ap_reward": 15,
            "condition_type": "view_event",
            "condition_count": 3,
            "is_active": True,
        },
        {
            "quest_type": QuestType.DAILY,
            "title": "프로필 완성하기",
            "description": "프로필 정보를 모두 채워주세요",
            "ap_reward": 20,
            "condition_type": "profile_complete",
            "condition_count": 1,
            "is_active": True,
        },
        # Weekly quests
        {
            "quest_type": QuestType.WEEKLY,
            "title": "5개 이벤트 응모하기",
            "description": "이번 주에 5개 이벤트에 응모하세요",
            "ap_reward": 50,
            "condition_type": "purchase",
            "condition_count": 5,
            "is_active": True,
        },
        {
            "quest_type": QuestType.WEEKLY,
            "title": "커뮤니티 활동하기",
            "description": "이번 주에 댓글 또는 리뷰를 5개 작성하세요",
            "ap_reward": 40,
            "condition_type": "community_activity",
            "condition_count": 5,
            "is_active": True,
        },
    ]

    async with async_session() as session:
        for q_data in quests_data:
            existing = await session.execute(
                select(Quest).where(Quest.title == q_data["title"])
            )
            if existing.scalar_one_or_none():
                print(f"  ⏭ 퀘스트 '{q_data['title']}' 이미 존재 — 스킵")
                continue

            quest = Quest(**q_data)
            session.add(quest)
            print(f"  ✓ 퀘스트 '{q_data['title']}' 생성")

        await session.commit()
    print("퀘스트 시드 완료\n")


async def run_all():
    await main()
    await ensure_enum_values()
    await seed_seats()
    await seed_quests()


if __name__ == "__main__":
    asyncio.run(run_all())
