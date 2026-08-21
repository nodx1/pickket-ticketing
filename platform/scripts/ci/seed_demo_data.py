#!/usr/bin/env python3
"""
Pickket v2 데모 데이터 시드 스크립트

배포 후 v2 RDS에 테스트/데모 계정 및 이벤트를 생성합니다.
멱등성(idempotent): 이미 존재하면 스킵합니다.

실행 방법:
  # 로컬
  cd backend && .venv/bin/python ../scripts/ci/seed_demo_data.py

  # ECS one-off task (배포 파이프라인에서)
  python scripts/ci/seed_demo_data.py
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

# backend 디렉토리를 sys.path에 추가
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), "backend")
sys.path.insert(0, BACKEND_DIR)

from sqlalchemy import text
from app.core.database import async_session
from app.core.security import hash_password

# ─── 상수 ────────────────────────────────────────────────────────────────────

PASSWORD = "PickketTest2026!"

USERS = [
    {
        "id": "8994b42c-3771-40b3-836a-26bb139a8ace",
        "email": "organizer@pickket.kr",
        "name": "픽켓 이벤트",
        "phone": "01000000002",
        "is_organizer": True,
        "is_admin": False,
        "admin_role": "viewer",
    },
    {
        "id": "b1b451fc-c8ca-4645-be40-d6f776a86f2c",
        "email": "admin@pickket.kr",
        "name": "관리자",
        "phone": "01000000001",
        "is_organizer": False,
        "is_admin": True,
        "admin_role": "admin",
    },
    {
        "id": "1cb5a765-34ac-4ba0-970b-ce4e1833de91",
        "email": "test@pickket.kr",
        "name": "테스트유저",
        "phone": "01012345678",
        "is_organizer": False,
        "is_admin": False,
        "admin_role": "viewer",
    },
    {
        "id": "991a4af2-d5ef-4d13-9b98-68f6d06771b6",
        "email": "user@pickket.kr",
        "name": "김민수",
        "phone": "01000000003",
        "is_organizer": False,
        "is_admin": False,
        "admin_role": "viewer",
    },
]

now = datetime.now(timezone.utc)

EVENTS = [
    {
        "id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "title": "ITZY 2026 BORN TO BE ENCORE in SEOUL",
        "status": "bidding_open",
        "category": "concert",
        "organizer_id": "8994b42c-3771-40b3-836a-26bb139a8ace",
        "venue": "KSPO DOME (올림픽공원 체조경기장)",
        "location_city": "서울",
        "artist_name": "ITZY",
        "min_price": "88000.00",
        "max_price": "264000.00",
        "image_url": "https://picsum.photos/seed/itzy-encore/800/1200",
        "total_seats": 8000,
        "bidding_opens_at": now - timedelta(days=2),
        "bidding_closes_at": now + timedelta(days=5),
        "event_date": now + timedelta(days=60),
        "description": (
            "ITZY 2026 앙코르 콘서트 \"BORN TO BE\" 서울 공연!\n\n"
            "🎤 공연 정보\n"
            "• 멤버십(MIDZY) 회원 대상 선판매 진행\n"
            "• 일반 판매에 앞서 팬클럽 회원에게 우선 구매 기회를 드립니다.\n\n"
            "🎵 예상 셋리스트\n"
            "• WANNABE / LOCO / SNEAKERS / CAKE / UNTOUCHABLE\n"
            "• 신곡 무대 최초 공개 예정\n\n"
            "💖 팬클럽 선판매 혜택\n"
            "• MIDZY 멤버십 회원 전용 10% 할인\n"
            "• VIP석 구매 시 사운드체크 리허설 관람 포함\n"
            "• 전석 포토카드 랜덤 1종 증정"
        ),
    },
    {
        "id": "d4f7a893-5a54-424e-9bef-d30cf73456fe",
        "title": "IU 2026 HEREH 앙코르 콘서트",
        "status": "bidding_open",
        "category": "concert",
        "organizer_id": "8994b42c-3771-40b3-836a-26bb139a8ace",
        "venue": "KSPO DOME (올림픽 체조경기장)",
        "location_city": "서울",
        "artist_name": "IU (아이유)",
        "min_price": "132000.00",
        "max_price": "198000.00",
        "image_url": "https://picsum.photos/seed/iu-hereh-hero/1200/675",
        "total_seats": 15000,
        "bidding_opens_at": now + timedelta(days=2),
        "bidding_closes_at": now + timedelta(days=47),
        "event_date": now + timedelta(days=49),
        "description": (
            "IU의 역대급 월드투어 'HEREH'의 서울 앙코르 공연!\n\n"
            "🎵 공연 소개\n"
            "전 세계 50만 관객을 사로잡은 HEREH 월드투어가\n"
            "서울 KSPO DOME에서 감동의 앙코르 무대를 펼칩니다.\n\n"
            "🌟 이번 앙코르만의 특별함\n"
            "• 서울 한정 스페셜 셋리스트 (월드투어 미공개곡 포함)\n"
            "• 밴드 라이브 + 오케스트라 협연 (특별 편성)\n"
            "• 앙코르 한정 포토카드 & 실버 라이트스틱 (현장 판매)\n"
            "• 무대 연출 업그레이드: 워터스크린 + 홀로그램 연출 추가"
        ),
    },
    {
        "id": "b6503729-ecd7-4d02-9446-19493bd28854",
        "title": "2026 신한 SOL뱅크 KBO 올스타전",
        "status": "bidding_open",
        "category": "sports",
        "organizer_id": "8994b42c-3771-40b3-836a-26bb139a8ace",
        "venue": "사직야구장",
        "location_city": "부산",
        "artist_name": None,
        "min_price": "55000.00",
        "max_price": "110000.00",
        "image_url": "https://picsum.photos/seed/kbo-allstar-hero/1200/675",
        "total_seats": 25000,
        "bidding_opens_at": now + timedelta(days=63),
        "bidding_closes_at": now + timedelta(days=103),
        "event_date": now + timedelta(days=105),
        "description": (
            "2026 KBO 올스타전이 부산 사직구장에서 개최됩니다!\n\n"
            "⚾ 대회 소개\n"
            "KBO리그 전반기 최고의 선수들이 한자리에 모이는 꿈의 무대.\n"
            "팬 투표로 선발된 나눔리그 vs 드림리그의 드림매치와 함께\n"
            "홈런더비, 올스타 퓨처스게임 등 풍성한 이벤트가 펼쳐집니다.\n\n"
            "🏟️ 경기 정보\n"
            "• 장소: 부산 사직야구장 (25,000석)\n"
            "• 주최: KBO한국야구위원회\n"
            "• 후원: 신한은행, SOL뱅크"
        ),
    },
]

SEAT_TIERS = [
    # ITZY — fanclub_presale
    {
        "id": "f1e2d3c4-b5a6-4978-8901-234567890abc",
        "event_id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "name": "VIP석",
        "capacity": 1500,
        "base_price": "264000.00",
        "face_price": "264000.00",
        "sale_mode": "fanclub_presale",
        "fanclub_discount_pct": 10.0,
        "seating_type": "assigned",
        "section_name": "FLOOR",
    },
    {
        "id": "f2e3d4c5-b6a7-4089-9012-345678901bcd",
        "event_id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "name": "R석",
        "capacity": 3000,
        "base_price": "176000.00",
        "face_price": "176000.00",
        "sale_mode": "fanclub_presale",
        "fanclub_discount_pct": 10.0,
        "seating_type": "assigned",
        "section_name": "1F",
    },
    {
        "id": "a90d0380-ea91-4d53-b957-d45be60f419e",
        "event_id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "name": "S석",
        "capacity": 2500,
        "base_price": "132000.00",
        "face_price": "132000.00",
        "sale_mode": "fanclub_presale",
        "fanclub_discount_pct": 10.0,
        "seating_type": "assigned",
        "section_name": "2F 앞",
    },
    {
        "id": "839b7a0d-18a4-4687-895c-ae0dbcb3b833",
        "event_id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "name": "A석",
        "capacity": 1000,
        "base_price": "88000.00",
        "face_price": "88000.00",
        "sale_mode": "fanclub_presale",
        "fanclub_discount_pct": 10.0,
        "seating_type": "assigned",
        "section_name": "2F 뒤",
    },
    # IU — point_lottery
    {
        "id": "170ac1f6-8798-4b42-a16b-bcc6886bc0de",
        "event_id": "d4f7a893-5a54-424e-9bef-d30cf73456fe",
        "name": "VIP석",
        "capacity": 200,
        "base_price": "198000.00",
        "face_price": "198000.00",
        "sale_mode": "point_lottery",
        "seating_type": "assigned",
        "section_name": "FLOOR VIP 구역",
        "view_description": "FLOOR 정면 최전방 스탠딩. 사운드체크 포함. IU 1~5m 근접.",
        "distance_from_stage": 3,
        "view_image_url": "https://picsum.photos/seed/kspo-iu-vip/800/400",
        "position_label": "FLOOR 정면 (VIP)",
    },
    {
        "id": "d05f9c3f-6af5-4d80-a896-4f043a40a5bf",
        "event_id": "d4f7a893-5a54-424e-9bef-d30cf73456fe",
        "name": "R석",
        "capacity": 300,
        "base_price": "132000.00",
        "face_price": "132000.00",
        "sale_mode": "point_lottery",
        "seating_type": "assigned",
        "section_name": "1층 지정석",
        "view_description": "FLOOR 후방 + 1층 지정좌석. 센터 무대(꽃길) 근접.",
        "distance_from_stage": 20,
        "view_image_url": "https://picsum.photos/seed/kspo-iu-r/800/400",
        "position_label": "FLOOR 후방 / 1층 (R석)",
    },
    # KBO — fixed_fcfs
    {
        "id": "ed00a350-e47c-4571-b8d5-c1d5faa15539",
        "event_id": "b6503729-ecd7-4d02-9446-19493bd28854",
        "name": "프리미엄석",
        "capacity": 300,
        "base_price": "110000.00",
        "face_price": "110000.00",
        "sale_mode": "fixed_fcfs",
        "seating_type": "assigned",
        "section_name": "내야 프리미엄 구역",
        "view_description": "1루/3루 내야 최전방 지정석. 덕아웃 근접 구역.",
        "distance_from_stage": 5,
        "view_image_url": "https://picsum.photos/seed/sajik-premium/800/400",
        "position_label": "내야 1-3열 (프리미엄)",
    },
    {
        "id": "5177b269-9e6f-44d1-8486-c7169a7ac5df",
        "event_id": "b6503729-ecd7-4d02-9446-19493bd28854",
        "name": "일반석",
        "capacity": 500,
        "base_price": "55000.00",
        "face_price": "55000.00",
        "sale_mode": "fixed_fcfs",
        "seating_type": "assigned",
        "section_name": "일반 관람 구역",
        "view_description": "내야/외야 지정좌석. 전체 그라운드 조망 가능.",
        "distance_from_stage": 30,
        "view_image_url": "https://picsum.photos/seed/sajik-general/800/400",
        "position_label": "내야/외야 지정석",
    },
]

FANCLUBS = [
    {
        "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "name": "MIDZY 공식 팬클럽",
        "artist_name": "ITZY",
        "description": "ITZY 공식 팬 커뮤니티 MIDZY입니다. 멤버십 회원에게 콘서트 선판매 혜택이 제공됩니다.",
        "organizer_id": "8994b42c-3771-40b3-836a-26bb139a8ace",
        "max_members": 50000,
        "is_official": True,
        "is_active": True,
        "community_type": "fanclub",
        "domain": "concert",
    },
]


async def seed():
    async with async_session() as db:
        hashed = hash_password(PASSWORD)

        # ─── Users ──────────────────────────────────────────────────
        for u in USERS:
            exists = await db.execute(
                text("SELECT 1 FROM users WHERE id = :id"),
                {"id": u["id"]},
            )
            if exists.scalar():
                print(f"  [SKIP] User {u['email']} already exists")
                continue

            await db.execute(
                text("""
                    INSERT INTO users (id, email, name, phone, hashed_password,
                                       is_organizer, is_admin, admin_role, is_active,
                                       created_at, updated_at)
                    VALUES (:id, :email, :name, :phone, :hashed_password,
                            :is_organizer, :is_admin, :admin_role, true,
                            now(), now())
                """),
                {**u, "hashed_password": hashed},
            )
            print(f"  [OK] User {u['email']} created")

        # ─── Events ─────────────────────────────────────────────────
        for e in EVENTS:
            exists = await db.execute(
                text("SELECT 1 FROM events WHERE id = :id"),
                {"id": e["id"]},
            )
            if exists.scalar():
                print(f"  [SKIP] Event '{e['title']}' already exists")
                continue

            await db.execute(
                text("""
                    INSERT INTO events (id, title, status, category, organizer_id,
                                        venue, location_city, artist_name,
                                        min_price, max_price, image_url,
                                        bidding_opens_at, bidding_closes_at, event_date,
                                        description, total_seats, bid_count, view_count,
                                        created_at, updated_at)
                    VALUES (:id, :title, :status, :category, :organizer_id,
                            :venue, :location_city, :artist_name,
                            :min_price, :max_price, :image_url,
                            :bidding_opens_at, :bidding_closes_at, :event_date,
                            :description, :total_seats, 0, 0,
                            now(), now())
                """),
                e,
            )
            print(f"  [OK] Event '{e['title']}' created")

        # ─── Seat Tiers ─────────────────────────────────────────────
        for t in SEAT_TIERS:
            exists = await db.execute(
                text("SELECT 1 FROM seat_tiers WHERE id = :id"),
                {"id": t["id"]},
            )
            if exists.scalar():
                print(f"  [SKIP] Tier '{t['name']}' already exists")
                continue

            # Fill defaults
            t.setdefault("fanclub_discount_pct", 0.0)
            t.setdefault("view_description", None)
            t.setdefault("distance_from_stage", None)
            t.setdefault("view_image_url", None)
            t.setdefault("position_label", None)

            await db.execute(
                text("""
                    INSERT INTO seat_tiers (id, event_id, name, capacity, base_price,
                                            face_price, sale_mode, fanclub_discount_pct,
                                            seating_type, section_name,
                                            view_description, distance_from_stage,
                                            view_image_url, position_label,
                                            sold_count, resale_allowed,
                                            allow_group_tickets, max_group_size,
                                            lottery_application_hours,
                                            min_price, max_price_cap,
                                            dutch_start_price, dutch_floor_price,
                                            dutch_step_amount, dutch_step_interval_min,
                                            resale_max_price)
                    VALUES (:id, :event_id, :name, :capacity, :base_price,
                            :face_price, :sale_mode, :fanclub_discount_pct,
                            :seating_type, :section_name,
                            :view_description, :distance_from_stage,
                            :view_image_url, :position_label,
                            0, true,
                            true, 4,
                            48,
                            0, 0,
                            0, 0,
                            0, 0,
                            0)
                """),
                t,
            )
            print(f"  [OK] Tier '{t['name']}' ({t['sale_mode']}) created")

        # ─── Fanclubs ───────────────────────────────────────────────
        for f in FANCLUBS:
            exists = await db.execute(
                text("SELECT 1 FROM fanclubs WHERE id = :id"),
                {"id": f["id"]},
            )
            if exists.scalar():
                print(f"  [SKIP] Fanclub '{f['name']}' already exists")
                continue

            await db.execute(
                text("""
                    INSERT INTO fanclubs (id, name, artist_name, description,
                                          organizer_id, max_members,
                                          is_official, is_active, community_type,
                                          domain, created_at, updated_at)
                    VALUES (:id, :name, :artist_name, :description,
                            :organizer_id, :max_members,
                            :is_official, :is_active, :community_type,
                            :domain, now(), now())
                """),
                f,
            )
            print(f"  [OK] Fanclub '{f['name']}' created")

        await db.commit()
        print("\n✅ 시드 데이터 완료!")


def main():
    print("=" * 60)
    print("Pickket v2 — 데모 데이터 시딩")
    print("=" * 60)
    asyncio.run(seed())


if __name__ == "__main__":
    main()
