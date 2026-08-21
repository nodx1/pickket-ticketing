#!/usr/bin/env python3
"""상세페이지 통합 검증 시드 데이터셋 — S4 (빈DB 함정 회피).

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §3(검증 시드 데이터셋).

목적:
    "빈 DB에서 통과했는데 실데이터에서 터진다" 함정을 막기 위해, 유형·상태·갭필드·
    좌석맵·랜딩채널·게스트 opt-in·주문 스펙트럼을 **의도적으로 분산**한 16개 이벤트를
    dev DB(v2 SoT)에 투입한다.

16 이벤트 매트릭스(§3):
    좌석지정 8 · 자유석 6 · 혼합 2
    sale_mode 5종: fixed_fcfs · point_lottery · queue · fanclub_presale · 무료RSVP(is_free+fcfs)
    admission: single · daypass · allpass
    status 분산: bidding_open · approved · completed · draft
    랜딩 노출: 마켓 13 · 화이트라벨 2(EV04·EV09) · 미노출 1(EV16 self-only)
    self-only 2(EV14·EV16)
    갭필드 풀채움: summary · event_schedules · seo_metadata · questions ·
        transport_info/parking_info · runtime/intermission · seat_map_data(좌석지정)
    guest_checkout_enabled: fixed_fcfs·무료 이벤트 일부에 True + guest_checkout_channels

주문 스펙트럼(§3):
    회원: confirmed · pending · payment_required · refunded · 부분환불 · daypass · used
    게스트: confirmed · 무료(free) · pending — buyer_email/phone·guest_id·order_no·
        guest_owner_id 티켓

전제/안전:
    - 멱등: EXTERNAL_REF_PREFIX('SEED_INT_') 로 마킹 → 재실행 시 스킵. `--clean` 으로
      본 시드 산출물만 선삭제(EXTERNAL_REF/이메일 접두 스코프 — 타 데이터 무손상).
    - 모든 PII 는 `@test.pickket.kr` / 010-99xx-xxxx (실 개인정보 없음).
    - SEED_ALLOW_PRODUCTION 게이트: ENVIRONMENT=production 이면 SEED_ALLOW_PRODUCTION=1
      없이는 실행 거부(prod 실수 방지).
    - sold_count 는 **trg_sync_sold_count** 트리거가 티켓 status 로부터 자동 산출한다.
      → 티켓을 만드는 주문은 sold_count 를 수동 세팅하지 않는다(이중계상 방지).

사용법:
    cd platform/backend && .venv/bin/python scripts/seed_integration.py
    cd platform/backend && .venv/bin/python scripts/seed_integration.py --clean
    cd platform/backend && .venv/bin/python scripts/seed_integration.py --clean --summary
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, or_, select

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.database import async_session  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.event import Event, EventStatus, SeatTier  # noqa: E402
from app.models.guest import Guest, GuestAccessToken  # noqa: E402
from app.models.order import Order, OrderStatus, OrderType  # noqa: E402
from app.models.ticket import Ticket, TicketStatus  # noqa: E402
from app.models.user import User  # noqa: E402

KST = ZoneInfo("Asia/Seoul")

# ---------------------------------------------------------------------------
# 스코프 마커 — 멱등 스킵 + --clean 선삭제 기준(타 데이터 무손상)
# ---------------------------------------------------------------------------
EXTERNAL_REF_PREFIX = "SEED_INT_"          # events/tiers/orders external_ref 접두
EMAIL_DOMAIN = "@test.pickket.kr"          # 모든 PII 이메일 도메인
ORG_EMAIL_PREFIX = "seedint-org-"          # 주최자 이메일 접두
MEMBER_EMAIL_PREFIX = "seedint-member-"    # 회원 이메일 접두
GUEST_EMAIL_PREFIX = "seedint-guest-"      # 게스트 이메일 접두
ORDER_NO_PREFIX = "SI-"                    # order_no(external_ref 로 저장) 접두


def _eref(*parts: str) -> str:
    return EXTERNAL_REF_PREFIX + "_".join(str(p) for p in parts)


# ---------------------------------------------------------------------------
# 갭필드 헬퍼 — §3 "풀채움"
# ---------------------------------------------------------------------------
def _schedules(*rows: tuple[str, str, str]) -> list[dict]:
    return [{"time": t, "title": ti, "description": d} for (t, ti, d) in rows]


def _seo(title: str, desc: str, keywords: list[str]) -> dict:
    return {
        "title": title,
        "description": desc,
        "keywords": keywords,
        "og_image": "https://cdn.pickket.kr/seed/og/placeholder-1200x630.png",
    }


def _questions(*rows: tuple[str, str, bool]) -> list[dict]:
    return [{"label": lbl, "type": ty, "required": req, "options": []} for (lbl, ty, req) in rows]


def _seat_map(floor_label: str) -> dict:
    """좌석지정 이벤트용 seat_map_data(go canvas 원본 shape, 무변환 roundtrip 계약)."""
    return {
        "version": 1,
        "maps": [
            {
                "id": str(uuid.uuid4()),
                "name": floor_label,
                "status": "published",
                "floor_index": 0,
                "floor_label": floor_label,
                "parent_map_id": None,
                "map_data": {
                    "canvas": {"width": 800, "height": 600},
                    "sections": [
                        {"id": "A", "label": "A구역", "x": 100, "y": 120, "rotation": 0},
                        {"id": "B", "label": "B구역", "x": 420, "y": 120, "rotation": 0},
                        {"id": "STAGE", "label": "무대", "x": 260, "y": 40, "rotation": 0},
                    ],
                },
                "background": {
                    "url": "https://cdn.pickket.kr/seed/venue/floorplan.png",
                    "opacity": 0.6,
                    "width": 800,
                    "height": 600,
                },
                "landmarks": [
                    {"label": "출입구", "x": 40, "y": 560},
                    {"label": "화장실", "x": 740, "y": 560},
                ],
            }
        ],
    }


# ---------------------------------------------------------------------------
# 16 이벤트 매트릭스 (§3)
#
#   seat_kind: assigned(좌석지정) / general(자유석) / mixed(혼합)
#   landing:   market(마켓노출) / white_label(화이트라벨) / hidden(미노출)
#   tiers[].sale_mode ∈ {fixed_fcfs, point_lottery, queue, fanclub_presale}
#     (무료RSVP = is_free=True + fixed_fcfs + base_price 0)
# ---------------------------------------------------------------------------
DEMO = [
    # EV01 — 골든/결제 페어. 좌석지정·fcfs·single·bidding_open·마켓. 게스트 opt-in.
    {
        "code": "EV01", "category": "concert", "org": "concert",
        "title": "[검증] SEVENTEEN 앙코르 — 골든 페어",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": True, "guest_channels": ["fixed_fcfs"],
        "gap": "full", "seat_map": True,
        "tiers": [
            {"name": "VIP", "price": 176000, "cap": 500, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "지정석 R", "price": 154000, "cap": 2000, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV02 — 결제 페어. 좌석지정·fcfs·single·bidding_open·마켓. runtime/intermission 강조.
    {
        "code": "EV02", "category": "musical", "org": "musical",
        "title": "[검증] 뮤지컬 오페라의 유령 — 러닝타임/인터미션",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "full", "seat_map": True, "runtime": 165, "intermission": 20,
        "tiers": [
            {"name": "VIP석", "price": 180000, "cap": 150, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "R석", "price": 140000, "cap": 400, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV03 — point_lottery(회원전용). 좌석지정·single·bidding_open·마켓. 게스트 opt-in=False.
    {
        "code": "EV03", "category": "concert", "org": "concert",
        "title": "[검증] 아이브 월드투어 — 포인트 추첨(회원전용)",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "partial", "seat_map": True,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "cap": 3000, "seating": "general", "mode": "point_lottery"},
            {"name": "지정석 R", "price": 143000, "cap": 4000, "seating": "assigned", "mode": "point_lottery"},
        ],
    },
    # EV04 — 화이트라벨(CNAME). 자유석·fcfs·single·bidding_open. 게스트 페어(게스트 e2e 대상).
    {
        "code": "EV04", "category": "festival", "org": "festival",
        "title": "[검증] 재즈페스티벌 — 화이트라벨 CNAME / 게스트 페어",
        "seat_kind": "general", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "white_label",
        "is_free": False, "guest_checkout": True, "guest_channels": ["fixed_fcfs", "free"],
        "gap": "full", "seat_map": False,
        "tiers": [
            {"name": "1일권", "price": 99000, "cap": 5000, "seating": "general", "mode": "fixed_fcfs"},
            {"name": "3일권", "price": 250000, "cap": 3000, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV05 — queue(대기열). 자유석·single·bidding_open·마켓.
    {
        "code": "EV05", "category": "concert", "org": "concert",
        "title": "[검증] 르세라핌 투어 — 대기열(queue)",
        "seat_kind": "general", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "partial", "seat_map": False,
        "tiers": [
            {"name": "스탠딩", "price": 132000, "cap": 2500, "seating": "general", "mode": "queue"},
        ],
    },
    # EV06 — 전시. 자유석·daypass·approved·마켓. transport/parking 강조. 게스트 opt-in.
    {
        "code": "EV06", "category": "exhibition", "org": "exhibition",
        "title": "[검증] 반 고흐 미디어아트 — 일권(daypass)/오시는길",
        "seat_kind": "general", "admission_mode": "daypass",
        "status": EventStatus.APPROVED, "landing": "market",
        "is_free": False, "guest_checkout": True, "guest_channels": ["fixed_fcfs"],
        "gap": "full", "seat_map": False, "multi_day": True,
        "tiers": [
            {"name": "일반 관람권", "price": 20000, "cap": 400, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV07 — 클래식. 좌석지정·single·bidding_open·마켓. questions(예매 설문) 강조.
    {
        "code": "EV07", "category": "classical", "org": "classical",
        "title": "[검증] 조성진 협연 — 예매 설문(questions)",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "full", "seat_map": True, "questions_heavy": True,
        "tiers": [
            {"name": "R석", "price": 150000, "cap": 400, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "S석", "price": 100000, "cap": 600, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV08 — 결제 페어(스포츠). 혼합(내야 지정+외야 자유)·single·bidding_open·마켓.
    {
        "code": "EV08", "category": "sports", "org": "sports",
        "title": "[검증] KBO 올스타전 — 혼합(지정+자유) 결제 페어",
        "seat_kind": "mixed", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": True, "guest_channels": ["fixed_fcfs"],
        "gap": "full", "seat_map": True,
        "tiers": [
            {"name": "중앙지정석", "price": 30000, "cap": 5000, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "외야자유석", "price": 15000, "cap": 8000, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV09 — 화이트라벨(white_label 서브도메인). 좌석지정·single·approved.
    {
        "code": "EV09", "category": "musical", "org": "musical",
        "title": "[검증] 레미제라블 — 화이트라벨 서브도메인",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.APPROVED, "landing": "white_label",
        "is_free": False, "guest_checkout": False,
        "gap": "full", "seat_map": True,
        "tiers": [
            {"name": "VIP석", "price": 190000, "cap": 200, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "R석", "price": 160000, "cap": 400, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV10 — fanclub_presale. 좌석지정·single·bidding_open·마켓.
    {
        "code": "EV10", "category": "concert", "org": "concert",
        "title": "[검증] DAY6 콘서트 — 팬클럽 선예매(fanclub_presale)",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "partial", "seat_map": True,
        "tiers": [
            {"name": "지정석 R", "price": 143000, "cap": 4000, "seating": "assigned", "mode": "fanclub_presale"},
        ],
    },
    # EV11 — 무료 RSVP(is_free+fcfs). 자유석·single·bidding_open·마켓. 게스트 opt-in(free).
    {
        "code": "EV11", "category": "festival", "org": "festival",
        "title": "[검증] 부산 불꽃축제 — 무료 RSVP(게스트 free)",
        "seat_kind": "general", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": True, "guest_checkout": True, "guest_channels": ["fixed_fcfs", "free"],
        "gap": "full", "seat_map": False,
        "tiers": [
            {"name": "일반 관람(무료)", "price": 0, "cap": 50000, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV12 — 게스트 페어(무료 e2e). 자유석·daypass(전시)·approved·마켓. 게스트 opt-in.
    {
        "code": "EV12", "category": "exhibition", "org": "exhibition",
        "title": "[검증] 모네전 무료 도슨트 — 게스트 무료 페어",
        "seat_kind": "general", "admission_mode": "daypass",
        "status": EventStatus.APPROVED, "landing": "market",
        "is_free": True, "guest_checkout": True, "guest_channels": ["fixed_fcfs", "free"],
        "gap": "full", "seat_map": False, "multi_day": True,
        "tiers": [
            {"name": "무료 도슨트", "price": 0, "cap": 300, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV13 — allpass(전일권). 혼합·bidding_open·마켓. 다일 이벤트.
    {
        "code": "EV13", "category": "festival", "org": "festival",
        "title": "[검증] 서울재즈 3일권 — 전일권(allpass)",
        "seat_kind": "mixed", "admission_mode": "allpass",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": False,
        "gap": "full", "seat_map": True, "multi_day": True,
        "tiers": [
            {"name": "VIP 라운지(3일)", "price": 500000, "cap": 200, "seating": "assigned", "mode": "fixed_fcfs"},
            {"name": "잔디 3일권", "price": 250000, "cap": 3000, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
    # EV14 — self-only(마켓 미노출, 주최자 자체판매). 좌석지정·single·bidding_open.
    {
        "code": "EV14", "category": "classical", "org": "classical",
        "title": "[검증] 서울숲 클래식 — self-only(자체판매)",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "self_only",
        "is_free": False, "guest_checkout": False,
        "gap": "partial", "seat_map": True,
        "tiers": [
            {"name": "의자석(지정)", "price": 55000, "cap": 400, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV15 — 게스트 페어(유료 e2e). 좌석지정·single·bidding_open·마켓. 게스트 opt-in.
    {
        "code": "EV15", "category": "sports", "org": "sports",
        "title": "[검증] K리그 슈퍼매치 — 게스트 유료 페어",
        "seat_kind": "assigned", "admission_mode": "single",
        "status": EventStatus.BIDDING_OPEN, "landing": "market",
        "is_free": False, "guest_checkout": True, "guest_channels": ["fixed_fcfs"],
        "gap": "full", "seat_map": True,
        "tiers": [
            {"name": "W석(중앙)", "price": 25000, "cap": 8000, "seating": "assigned", "mode": "fixed_fcfs"},
        ],
    },
    # EV16 — draft + self-only(미노출). 자유석·single. status draft 커버.
    {
        "code": "EV16", "category": "concert", "org": "concert",
        "title": "[검증] 미공개 준비중 공연 — draft/미노출",
        "seat_kind": "general", "admission_mode": "single",
        "status": EventStatus.DRAFT, "landing": "self_only",
        "is_free": False, "guest_checkout": False,
        "gap": "partial", "seat_map": False,
        "tiers": [
            {"name": "일반", "price": 88000, "cap": 1000, "seating": "general", "mode": "fixed_fcfs"},
        ],
    },
]

# ---------------------------------------------------------------------------
# 도메인별 주최자
# ---------------------------------------------------------------------------
ORG_DOMAINS = ["concert", "musical", "festival", "exhibition", "sports", "classical"]
ORG_NAMES = {
    "concert": "[SEED] 라이브네이션검증",
    "musical": "[SEED] 신시컴퍼니검증",
    "festival": "[SEED] 페스티벌코리아검증",
    "exhibition": "[SEED] 아트플래닛검증",
    "sports": "[SEED] K스포츠검증",
    "classical": "[SEED] 서울아트검증",
}


# ---------------------------------------------------------------------------
# --clean — 본 시드 산출물만 스코프 삭제(타 데이터 무손상)
# ---------------------------------------------------------------------------
async def clean(session) -> dict:
    """EXTERNAL_REF/이메일 접두 스코프로 본 시드 산출물만 선삭제.

    삭제 순서(FK 역방향): guest_access_tokens → tickets → orders → guests →
    seat_tiers → events → users(주최자/회원). 게스트는 orders 삭제 후.
    """
    stats = {"orders": 0, "tickets": 0, "events": 0, "guests": 0, "users": 0}

    # 본 시드 이벤트 id
    ev_ids = (
        (await session.execute(
            select(Event.id).where(Event.external_ref.like(f"{EXTERNAL_REF_PREFIX}%"))
        )).scalars().all()
    )
    # 본 시드 주문 id (이벤트 스코프 + order_no 접두 이중조건 → 안전)
    if ev_ids:
        ord_ids = (
            (await session.execute(
                select(Order.id).where(
                    Order.event_id.in_(ev_ids),
                    Order.external_ref.like(f"{ORDER_NO_PREFIX}%"),
                )
            )).scalars().all()
        )
    else:
        ord_ids = []

    if ord_ids:
        # guest_access_tokens(order FK CASCADE 이지만 명시 삭제)
        await session.execute(
            delete(GuestAccessToken).where(GuestAccessToken.order_id.in_(ord_ids))
        )
        t = await session.execute(
            delete(Ticket).where(Ticket.purchase_order_id.in_(ord_ids))
        )
        stats["tickets"] = t.rowcount or 0
        o = await session.execute(delete(Order).where(Order.id.in_(ord_ids)))
        stats["orders"] = o.rowcount or 0

    # 게스트(본 시드 이메일 접두) — 남은 토큰 정리 후 삭제
    guest_ids = (
        (await session.execute(
            select(Guest.id).where(Guest.email.like(f"{GUEST_EMAIL_PREFIX}%"))
        )).scalars().all()
    )
    if guest_ids:
        await session.execute(
            delete(GuestAccessToken).where(GuestAccessToken.guest_id.in_(guest_ids))
        )
        g = await session.execute(delete(Guest).where(Guest.id.in_(guest_ids)))
        stats["guests"] = g.rowcount or 0

    # tiers → events
    if ev_ids:
        await session.execute(delete(SeatTier).where(SeatTier.event_id.in_(ev_ids)))
        e = await session.execute(delete(Event).where(Event.id.in_(ev_ids)))
        stats["events"] = e.rowcount or 0

    # 회원/주최자(본 시드 이메일 접두)
    u = await session.execute(
        delete(User).where(
            or_(
                User.email.like(f"{ORG_EMAIL_PREFIX}%{EMAIL_DOMAIN}"),
                User.email.like(f"{MEMBER_EMAIL_PREFIX}%{EMAIL_DOMAIN}"),
            )
        )
    )
    stats["users"] = u.rowcount or 0

    await session.commit()
    return stats


# ---------------------------------------------------------------------------
# 계정 시드
# ---------------------------------------------------------------------------
async def _get_or_create_user(session, *, email, name, is_organizer=False) -> User:
    existing = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()
    if existing:
        return existing
    u = User(
        email=email,
        hashed_password=hash_password("SeedInt2026!"),
        name=name,
        is_organizer=is_organizer,
        is_verified=True,
        is_active=True,
        preferred_language="ko",
    )
    session.add(u)
    await session.flush()
    return u


async def seed_accounts(session) -> tuple[dict[str, User], list[User]]:
    """도메인별 주최자 6 + 회원 8(주문 스펙트럼 소유자)."""
    orgs: dict[str, User] = {}
    for dom in ORG_DOMAINS:
        orgs[dom] = await _get_or_create_user(
            session,
            email=f"{ORG_EMAIL_PREFIX}{dom}{EMAIL_DOMAIN}",
            name=ORG_NAMES[dom],
            is_organizer=True,
        )
    members: list[User] = []
    for i in range(1, 9):
        members.append(
            await _get_or_create_user(
                session,
                email=f"{MEMBER_EMAIL_PREFIX}{i:02d}{EMAIL_DOMAIN}",
                name=f"[SEED] 검증회원{i:02d}",
            )
        )
    await session.flush()
    return orgs, members


# ---------------------------------------------------------------------------
# 이벤트 시드
# ---------------------------------------------------------------------------
def _apply_gap_fields(ev: Event, spec: dict, now: datetime) -> None:
    """갭필드 풀채움(§3). full=전필드, partial=핵심만."""
    title = spec["title"]
    ev.summary = f"{title} — 한 줄 요약(검증 시드)."
    ev.event_schedules = _schedules(
        ("18:00", "입장 시작", "게이트 오픈 및 좌석 안내"),
        ("19:00", "본 공연 시작", "1부 프로그램"),
        ("20:30", "종료", "퇴장 안내"),
    )
    ev.seo_metadata = _seo(
        title,
        f"{title}의 검증용 SEO 설명입니다.",
        [spec["category"], "피켓", "검증시드"],
    )
    if spec.get("gap") == "full":
        ev.questions = _questions(
            ("동행자 성함", "text", False),
            ("교통 수단", "select", False),
            ("개인정보 수집 동의", "checkbox", True),
        )
        ev.transport_info = "지하철 2호선 OO역 3번 출구 도보 5분. 셔틀버스 운행."
        ev.parking_info = "현장 주차 불가 — 인근 공영주차장 이용 권장."
        if spec.get("questions_heavy"):
            ev.questions = _questions(
                ("좌석 선호(중앙/좌/우)", "select", True),
                ("휠체어 좌석 필요 여부", "checkbox", False),
                ("프로그램북 구매", "checkbox", False),
                ("연락처(비상)", "text", True),
            )
        if spec.get("runtime"):
            ev.runtime_minutes = spec["runtime"]
            ev.intermission_minutes = spec.get("intermission", 0)
        else:
            ev.runtime_minutes = 120
            ev.intermission_minutes = 15
    else:
        # partial — 핵심만(summary/schedules/seo 는 위에서 이미)
        ev.transport_info = "대중교통 이용 권장."

    if spec.get("seat_map"):
        ev.seat_map_data = _seat_map("1층")
        ev.seat_map_url = "https://cdn.pickket.kr/seed/venue/seatmap-thumb.png"


async def seed_events(session, orgs, now) -> dict[str, Event]:
    """16 이벤트 + tiers. external_ref 로 멱등. 반환: code→Event."""
    result: dict[str, Event] = {}
    for spec in DEMO:
        code = spec["code"]
        eref = _eref("ev", code)
        existing = (
            await session.execute(select(Event).where(Event.external_ref == eref))
        ).scalar_one_or_none()
        if existing:
            result[code] = existing
            continue

        org = orgs[spec["org"]]
        tiers = spec["tiers"]
        total_seats = sum(t["cap"] for t in tiers)
        prices = [t["price"] for t in tiers if t["price"] > 0]
        min_price = min(prices) if prices else 0
        max_price = max(prices) if prices else None

        event_date = now + timedelta(days=30)
        event_date_end = (now + timedelta(days=32)) if spec.get("multi_day") else None
        bidding_opens_at = now - timedelta(days=3)
        bidding_closes_at = event_date - timedelta(days=1)

        # 랜딩 노출 → sale_channels 매핑
        landing = spec["landing"]
        if landing in ("market", "white_label"):
            sale_channels = ["self", "marketplace"]
        else:  # self_only
            sale_channels = ["self"]

        slug = f"seed-int-{code.lower()}-{uuid.uuid4().hex[:6]}"
        seat_type = "unassigned" if spec["seat_kind"] == "general" else "assigned"

        ev = Event(
            organizer_id=org.id,
            title=spec["title"],
            slug=slug,
            external_ref=eref,
            description=f"{spec['title']}\n\n검증 시드 데이터셋(§3). 실데이터급 회귀 검증용.",
            venue="[SEED] 검증 공연장",
            venue_id=None,
            event_date=event_date,
            event_date_end=event_date_end,
            bidding_opens_at=bidding_opens_at,
            bidding_closes_at=bidding_closes_at,
            total_seats=total_seats,
            min_price=min_price,
            max_price=max_price,
            category=spec["category"],
            status=spec["status"],
            location_city="서울",
            is_free=spec.get("is_free", False),
            sale_channels=sale_channels,
            admission_mode=spec["admission_mode"],
            seat_type=seat_type,
            guest_checkout_enabled=spec.get("guest_checkout", False),
            guest_checkout_channels=spec.get("guest_channels"),
        )
        _apply_gap_fields(ev, spec, now)
        session.add(ev)
        await session.flush()

        for t in tiers:
            session.add(
                SeatTier(
                    event_id=ev.id,
                    external_ref=_eref("tier", code, t["name"]),
                    name=t["name"],
                    capacity=t["cap"],
                    base_price=float(t["price"]),
                    face_price=float(t["price"]),
                    min_price=float(t["price"]),
                    sale_mode=t["mode"],
                    seating_type=t["seating"],
                    section_name=t["name"],
                    sold_count=0,  # 트리거가 티켓 status 로 산출 — 수동세팅 금지
                )
            )
        await session.flush()
        result[code] = ev
    return result


# ---------------------------------------------------------------------------
# 주문 스펙트럼 (§3)
#
#   회원: confirmed / pending / payment_required / refunded / 부분환불 / daypass / used
#   게스트: confirmed / 무료(free) / pending
#
#   ⚠️ sold_count 는 trg_sync_sold_count 가 티켓 INSERT/UPDATE 로 자동 관리 →
#      티켓 발권 주문(confirmed/used/daypass/refunded)만 tier.sold_count 에 반영된다.
#      pending/payment_required 는 티켓 미발권(재고 hold 는 별도) → 여기선 미발권.
# ---------------------------------------------------------------------------
async def _first_tier(session, ev: Event) -> SeatTier:
    return (
        await session.execute(
            select(SeatTier).where(SeatTier.event_id == ev.id).order_by(SeatTier.base_price.desc())
        )
    ).scalars().first()


def _order_no(code: str, tag: str) -> str:
    return f"{ORDER_NO_PREFIX}{code}-{tag}-{uuid.uuid4().hex[:6]}"


async def _member_order(
    session, *, ev, tier, member, status, qty=1, tag="ord",
    with_ticket=False, ticket_status=TicketStatus.ACTIVE, admission_day=None,
    total_refunded=0, payment_method=None,
) -> Order:
    unit = tier.base_price
    total = unit * qty
    o = Order(
        user_id=member.id,
        guest_id=None,
        event_id=ev.id,
        tier_id=tier.id,
        order_type=OrderType.PURCHASE,
        status=status,
        quantity=qty,
        unit_price=unit,
        total_amount=total,
        total_refunded=total_refunded,
        external_ref=_order_no(ev.external_ref.replace(EXTERNAL_REF_PREFIX, ""), tag),
        buyer_name=member.name,
        buyer_email=member.email,
        payment_method=payment_method,
    )
    session.add(o)
    await session.flush()
    if with_ticket:
        for _ in range(qty):
            session.add(
                Ticket(
                    event_id=ev.id,
                    tier_id=tier.id,
                    current_owner_id=member.id,
                    original_owner_id=member.id,
                    guest_owner_id=None,
                    purchase_price=unit,
                    sale_mode=tier.sale_mode,
                    purchase_order_id=o.id,
                    status=ticket_status,
                    admission_day=admission_day,
                    checked_in_at=(datetime.now(timezone.utc) if ticket_status == TicketStatus.USED else None),
                )
            )
        await session.flush()
    return o


async def _guest_order(
    session, *, ev, tier, guest, status, qty=1, tag="guest",
    with_ticket=False, ticket_status=TicketStatus.ACTIVE, free=False,
) -> Order:
    unit = tier.base_price
    total = unit * qty
    o = Order(
        user_id=None,
        guest_id=guest.id,
        event_id=ev.id,
        tier_id=tier.id,
        order_type=OrderType.PURCHASE,
        status=status,
        quantity=qty,
        unit_price=unit,
        total_amount=total,
        external_ref=_order_no(ev.external_ref.replace(EXTERNAL_REF_PREFIX, ""), tag),
        buyer_name=guest.name,
        buyer_email=guest.email,
        buyer_phone="010-9900-0000",
        payment_method=("free" if free else "card"),
    )
    session.add(o)
    await session.flush()
    if with_ticket:
        for _ in range(qty):
            session.add(
                Ticket(
                    event_id=ev.id,
                    tier_id=tier.id,
                    current_owner_id=None,
                    guest_owner_id=guest.id,  # 게스트 소유(XOR)
                    purchase_price=unit,
                    sale_mode=tier.sale_mode,
                    purchase_order_id=o.id,
                    status=ticket_status,
                )
            )
        await session.flush()
    return o


async def seed_orders(session, events, members) -> dict:
    """회원 + 게스트 주문 스펙트럼. 멱등: 본 시드 주문 이미 있으면 스킵."""
    stats = {"member": 0, "guest": 0, "tickets": 0, "guests": 0}

    # 멱등 가드 — 본 시드 이벤트에 이미 SI- 주문 있으면 전체 스킵
    ev_ids = [e.id for e in events.values()]
    existing = (
        await session.execute(
            select(func.count(Order.id)).where(
                Order.event_id.in_(ev_ids), Order.external_ref.like(f"{ORDER_NO_PREFIX}%")
            )
        )
    ).scalar_one()
    if existing and existing > 0:
        stats["skipped"] = existing
        return stats

    ev01, ev02, ev04, ev06 = events["EV01"], events["EV02"], events["EV04"], events["EV06"]
    ev11, ev12, ev15 = events["EV11"], events["EV12"], events["EV15"]

    t01 = await _first_tier(session, ev01)
    t02 = await _first_tier(session, ev02)
    t04 = await _first_tier(session, ev04)
    t06 = await _first_tier(session, ev06)
    t11 = await _first_tier(session, ev11)
    t12 = await _first_tier(session, ev12)
    t15 = await _first_tier(session, ev15)

    m = members
    # ── 회원 주문 스펙트럼 ──
    await _member_order(session, ev=ev01, tier=t01, member=m[0], status=OrderStatus.CONFIRMED,
                        tag="confirmed", with_ticket=True, ticket_status=TicketStatus.ACTIVE,
                        payment_method="card"); stats["member"] += 1
    await _member_order(session, ev=ev01, tier=t01, member=m[1], status=OrderStatus.PENDING,
                        tag="pending"); stats["member"] += 1
    await _member_order(session, ev=ev02, tier=t02, member=m[2], status=OrderStatus.PAYMENT_REQUIRED,
                        tag="payreq"); stats["member"] += 1
    # refunded — total_refunded == total_amount
    ro = await _member_order(session, ev=ev02, tier=t02, member=m[3], status=OrderStatus.CONFIRMED,
                             tag="refund-seed", with_ticket=True, ticket_status=TicketStatus.CANCELLED,
                             payment_method="card")
    ro.status = OrderStatus.REFUNDED
    ro.total_refunded = ro.total_amount
    stats["member"] += 1
    # 부분환불 — total_refunded < total_amount, qty 2
    po = await _member_order(session, ev=ev02, tier=t02, member=m[4], status=OrderStatus.CONFIRMED,
                             tag="partial", qty=2, with_ticket=True, ticket_status=TicketStatus.ACTIVE,
                             payment_method="card")
    po.status = OrderStatus.PARTIALLY_REFUNDED
    po.total_refunded = po.unit_price  # 1장분 환불
    stats["member"] += 1
    # daypass — admission_day 세팅
    from datetime import date as _date
    await _member_order(session, ev=ev06, tier=t06, member=m[5], status=OrderStatus.CONFIRMED,
                        tag="daypass", with_ticket=True, ticket_status=TicketStatus.ACTIVE,
                        admission_day=_date.today() + timedelta(days=30), payment_method="card")
    stats["member"] += 1
    # used — 체크인 완료
    await _member_order(session, ev=ev06, tier=t06, member=m[6], status=OrderStatus.CONFIRMED,
                        tag="used", with_ticket=True, ticket_status=TicketStatus.USED,
                        payment_method="card"); stats["member"] += 1

    # ── 게스트 주문 스펙트럼 ──
    async def _mk_guest(idx, name):
        g = Guest(
            email=f"{GUEST_EMAIL_PREFIX}{idx:02d}{EMAIL_DOMAIN}",
            name=name,
            marketing_opt_in=(idx % 2 == 0),
        )
        session.add(g)
        await session.flush()
        stats["guests"] += 1
        return g

    g1 = await _mk_guest(1, "[SEED] 게스트김")
    g2 = await _mk_guest(2, "[SEED] 게스트이")
    g3 = await _mk_guest(3, "[SEED] 게스트박")

    # 게스트 confirmed(유료 + 게스트 소유 티켓)
    await _guest_order(session, ev=ev04, tier=t04, guest=g1, status=OrderStatus.CONFIRMED,
                       tag="g-confirmed", with_ticket=True, ticket_status=TicketStatus.ACTIVE)
    stats["guest"] += 1
    # 게스트 무료(free) — 0원 confirmed, payment_method='free'
    await _guest_order(session, ev=ev12, tier=t12, guest=g2, status=OrderStatus.CONFIRMED,
                       tag="g-free", with_ticket=True, ticket_status=TicketStatus.ACTIVE, free=True)
    stats["guest"] += 1
    # 게스트 pending(미결제, 티켓 미발권)
    await _guest_order(session, ev=ev15, tier=t15, guest=g3, status=OrderStatus.PENDING,
                       tag="g-pending")
    stats["guest"] += 1
    # 게스트 무료 RSVP(EV11) confirmed
    g4 = await _mk_guest(4, "[SEED] 게스트최")
    await _guest_order(session, ev=ev11, tier=t11, guest=g4, status=OrderStatus.CONFIRMED,
                       tag="g-rsvp", with_ticket=True, ticket_status=TicketStatus.ACTIVE, free=True)
    stats["guest"] += 1

    await session.commit()

    # 티켓 수 집계(본 시드 이벤트 스코프)
    tcount = (
        await session.execute(
            select(func.count(Ticket.id)).where(Ticket.event_id.in_(ev_ids))
        )
    ).scalar_one()
    stats["tickets"] = tcount
    return stats


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
async def run(*, do_clean: bool, do_summary: bool) -> None:
    from app.core.config import settings

    if settings.ENVIRONMENT == "production" and os.environ.get("SEED_ALLOW_PRODUCTION") != "1":
        print("🚫 ENVIRONMENT=production 에서는 검증 시드를 실행하지 않습니다 "
              "(prod 실수 방지). 정말 필요하면 SEED_ALLOW_PRODUCTION=1 로 실행.")
        return

    now = datetime.now(KST)
    print(f"\n{'='*56}\n  상세통합 검증 시드(S4) — 16이벤트 매트릭스 + 주문 스펙트럼\n{'='*56}")
    print(f"  ENVIRONMENT={settings.ENVIRONMENT}  (dev DB 전용)")

    async with async_session() as session:
        if do_clean:
            cs = await clean(session)
            print(f"  🧹 clean: events={cs['events']} orders={cs['orders']} "
                  f"tickets={cs['tickets']} guests={cs['guests']} users={cs['users']}")

        orgs, members = await seed_accounts(session)
        await session.commit()
        print(f"  ✓ 주최자 {len(orgs)} · 회원 {len(members)}")

        events = await seed_events(session, orgs, now)
        await session.commit()
        print(f"  ✓ 이벤트 {len(events)}/{len(DEMO)}")

        ostats = await seed_orders(session, events, members)
        if ostats.get("skipped"):
            print(f"  ⏭ 주문 이미 존재({ostats['skipped']}건) — 스킵(멱등)")
        else:
            print(f"  ✓ 회원주문 {ostats['member']} · 게스트주문 {ostats['guest']} · "
                  f"게스트 {ostats['guests']} · 티켓 {ostats['tickets']}")

    if do_summary:
        await print_summary()

    print(f"{'='*56}\n  완료.\n{'='*56}\n")


async def print_summary() -> None:
    """본 시드 스코프 집계 리포트(검증용)."""
    async with async_session() as session:
        ev_ids = (
            (await session.execute(
                select(Event.id).where(Event.external_ref.like(f"{EXTERNAL_REF_PREFIX}%"))
            )).scalars().all()
        )
        n_ev = len(ev_ids)
        n_guest_ck = (
            await session.execute(
                select(func.count(Event.id)).where(
                    Event.external_ref.like(f"{EXTERNAL_REF_PREFIX}%"),
                    Event.guest_checkout_enabled.is_(True),
                )
            )
        ).scalar_one()
        by_status = (
            await session.execute(
                select(Order.status, func.count(Order.id))
                .where(Order.event_id.in_(ev_ids), Order.external_ref.like(f"{ORDER_NO_PREFIX}%"))
                .group_by(Order.status)
            )
        ).all()
        n_guest_orders = (
            await session.execute(
                select(func.count(Order.id)).where(
                    Order.event_id.in_(ev_ids),
                    Order.guest_id.isnot(None),
                    Order.external_ref.like(f"{ORDER_NO_PREFIX}%"),
                )
            )
        ).scalar_one()
        n_member_orders = (
            await session.execute(
                select(func.count(Order.id)).where(
                    Order.event_id.in_(ev_ids),
                    Order.user_id.isnot(None),
                    Order.external_ref.like(f"{ORDER_NO_PREFIX}%"),
                )
            )
        ).scalar_one()
        n_guest_tickets = (
            await session.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.event_id.in_(ev_ids), Ticket.guest_owner_id.isnot(None)
                )
            )
        ).scalar_one()
        print(f"\n  ── 시드 집계(스코프: {EXTERNAL_REF_PREFIX}*) ──")
        print(f"  이벤트: {n_ev}  (게스트 opt-in {n_guest_ck})")
        print(f"  회원주문: {n_member_orders} · 게스트주문: {n_guest_orders} "
              f"(게스트비율 {n_guest_orders}/{n_member_orders + n_guest_orders})")
        print(f"  게스트 소유 티켓(guest_owner_id): {n_guest_tickets}")
        print("  주문 status 분포:")
        for st, c in by_status:
            sv = st.value if hasattr(st, "value") else st
            print(f"    {sv:20s} {c}")


def main() -> None:
    ap = argparse.ArgumentParser(description="상세통합 검증 시드(S4)")
    ap.add_argument("--clean", action="store_true", help="본 시드 산출물 선삭제(스코프)")
    ap.add_argument("--summary", action="store_true", help="시드 후 집계 리포트 출력")
    args = ap.parse_args()
    asyncio.run(run(do_clean=args.clean, do_summary=args.summary))


if __name__ == "__main__":
    main()
