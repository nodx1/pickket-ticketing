"""챗봇 이벤트별 context + conversation_id Redis/세션 바인딩 테스트 (레벨2 3.4b).

검증 축:
- 이벤트별 context 주입(build_event_context): 제목·일시·장소·판매상태·티켓 정보.
- conversation_id Redis 저장(멀티워커 안전) + 세션(소유자) 바인딩(격리).
- whitespace/에스컬레이션/FAQ 회귀 무변.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.user import User
from app.services import chatbot_service as cs

from app.tests.conftest import TestSession


# ── 픽스처: 이벤트 + 티켓 등급 시드 ──────────────────────────────────────────


@pytest_asyncio.fixture
async def seeded_event(db_session):
    """판매중 이벤트 1건(티켓 2등급) 시드 후 event_id(str) 반환."""
    now = datetime.now(timezone.utc)
    organizer = User(
        id=uuid.uuid4(),
        email=f"org-{uuid.uuid4().hex[:8]}@example.com",
        hashed_password="x",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(organizer)
    await db_session.flush()

    event = Event(
        id=uuid.uuid4(),
        organizer_id=organizer.id,
        title="피켓 여름 콘서트",
        slug=f"summer-{uuid.uuid4().hex[:8]}",
        description="테스트 공연",
        venue="올림픽홀",
        venue_address="서울 송파구",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(hours=1),
        bidding_closes_at=now + timedelta(hours=24),
        total_seats=100,
        min_price=10000,
        max_price=50000,
        category="concert",
        artist_name="테스트밴드",
        status=EventStatus.BIDDING_OPEN,
        context_banner="선착순 판매중!",
    )
    db_session.add(event)
    await db_session.flush()

    db_session.add_all(
        [
            SeatTier(
                id=uuid.uuid4(),
                event_id=event.id,
                name="R석",
                capacity=50,
                base_price=50000,
                sold_count=10,
            ),
            SeatTier(
                id=uuid.uuid4(),
                event_id=event.id,
                name="S석",
                capacity=50,
                base_price=30000,
                sold_count=50,  # 매진 등급
            ),
        ]
    )
    await db_session.commit()
    return str(event.id)


# ── 이벤트별 context ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_build_event_context_includes_core_info(db_session, seeded_event):
    ctx = await cs.build_event_context(seeded_event, db_session)
    assert ctx is not None
    assert "피켓 여름 콘서트" in ctx
    assert "올림픽홀" in ctx
    assert "서울 송파구" in ctx
    assert "테스트밴드" in ctx
    # 판매상태: 전체 매진 아님(R석 잔여) → 판매중
    assert "판매중" in ctx
    # 티켓 등급 + 가격 + 잔여/매진 표기
    assert "R석" in ctx and "50,000원" in ctx
    assert "잔여 40석" in ctx  # R석 50-10
    assert "S석" in ctx and "매진" in ctx  # S석 50/50
    # 주최자 배너
    assert "선착순 판매중!" in ctx


@pytest.mark.asyncio
async def test_build_event_context_invalid_id_returns_none(db_session):
    assert await cs.build_event_context("not-a-uuid", db_session) is None
    assert await cs.build_event_context(str(uuid.uuid4()), db_session) is None


@pytest.mark.asyncio
async def test_derive_sale_status_paused_and_cancelled(db_session, seeded_event):
    # sales_paused → 일시중지
    async with TestSession() as s:
        from sqlalchemy import select

        ev = (await s.execute(select(Event).where(Event.id == uuid.UUID(seeded_event)))).scalar_one()
        ev.sales_paused = True
        await s.commit()
    ctx = await cs.build_event_context(seeded_event, db_session)
    assert "판매 일시중지" in ctx

    async with TestSession() as s:
        from sqlalchemy import select

        ev = (await s.execute(select(Event).where(Event.id == uuid.UUID(seeded_event)))).scalar_one()
        ev.status = EventStatus.CANCELLED
        await s.commit()
    ctx2 = await cs.build_event_context(seeded_event, db_session)
    assert "취소됨" in ctx2


@pytest.mark.asyncio
async def test_event_context_injected_into_llm_system_prompt(db_session, seeded_event, monkeypatch):
    """event_id 전달 시 LLM 시스템프롬프트에 이벤트 정보가 주입되는지."""
    settings.CHATBOT_LLM_API_URL = "http://llm.test"
    captured: dict = {}

    async def _fake_call_llm(message, ctx, db, user_id, event_context=None):
        captured["event_context"] = event_context
        return "이 공연은 올림픽홀에서 열립니다."

    monkeypatch.setattr(cs, "_call_llm", _fake_call_llm)
    try:
        resp = await cs.handle_chat_message(
            message="이 공연 어디서 하나요",
            conversation_id=None,
            db=db_session,
            user_id=None,
            event_id=seeded_event,
        )
    finally:
        settings.CHATBOT_LLM_API_URL = ""

    assert resp.tier == 1
    assert captured["event_context"] is not None
    assert "올림픽홀" in captured["event_context"]


@pytest.mark.asyncio
async def test_no_event_id_means_no_context(db_session, monkeypatch):
    settings.CHATBOT_LLM_API_URL = "http://llm.test"
    captured: dict = {}

    async def _fake_call_llm(message, ctx, db, user_id, event_context=None):
        captured["event_context"] = event_context
        return "무엇을 도와드릴까요"

    monkeypatch.setattr(cs, "_call_llm", _fake_call_llm)
    try:
        await cs.handle_chat_message(
            message="주문 관련 문의요",  # FAQ 강매칭 회피용 일반 문의
            conversation_id=None,
            db=db_session,
            user_id=None,
            event_id=None,
        )
    finally:
        settings.CHATBOT_LLM_API_URL = ""

    assert captured.get("event_context") is None


# ── conversation_id Redis + 세션 바인딩 ──────────────────────────────────────


@pytest.mark.asyncio
async def test_conversation_persisted_to_redis(db_session):
    """대화가 Redis(v2: prefix)에 저장되고 conversation_id 로 재조회되는지."""
    from app.core.redis import get_redis

    resp = await cs.handle_chat_message(
        message="환불 어떻게 하나요",  # Tier 0 FAQ
        conversation_id=None,
        db=db_session,
        user_id=None,
    )
    cid = resp.conversation_id
    assert cid

    r = get_redis()
    raw = await r.get(cs._conv_redis_key(cid))
    assert raw is not None
    data = json.loads(raw)
    # 사용자 메시지 + 어시스턴트 응답 기록
    assert any(m["role"] == "user" for m in data["messages"])
    assert data["owner"] == "guest"
    # v2 키 prefix 규약
    assert cs._conv_redis_key(cid).startswith("v2:chat:conv:")


@pytest.mark.asyncio
async def test_conversation_continuity_multiworker(db_session):
    """Redis 저장 → 다른 '워커'(새 함수 호출)에서 이력 이어짐(멀티워커 안전)."""
    r1 = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id=None,
        db=db_session,
        user_id=None,
    )
    cid = r1.conversation_id

    # 같은 conversation_id 로 후속 메시지 → 이력 누적
    await cs.handle_chat_message(
        message="결제 수단 뭐 있나요",
        conversation_id=cid,
        db=db_session,
        user_id=None,
    )

    from app.core.redis import get_redis

    raw = await get_redis().get(cs._conv_redis_key(cid))
    data = json.loads(raw)
    contents = " ".join(m["content"] for m in data["messages"])
    assert "환불" in contents and "결제" in contents


@pytest.mark.asyncio
async def test_member_conversation_isolated_from_other_member(db_session):
    """회원 A 의 conversation_id 를 회원 B 가 제시해도 접근 불가(신규 대화 발급)."""
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    ra = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id=None,
        db=db_session,
        user_id=user_a,
    )
    cid_a = ra.conversation_id

    # 회원 B 가 A 의 conversation_id 제시 → 격리: 새 conversation_id 반환
    rb = await cs.handle_chat_message(
        message="결제 수단",
        conversation_id=cid_a,
        db=db_session,
        user_id=user_b,
    )
    assert rb.conversation_id != cid_a

    # A 의 대화는 손상되지 않음(owner 유지)
    from app.core.redis import get_redis

    raw = await get_redis().get(cs._conv_redis_key(cid_a))
    assert json.loads(raw)["owner"] == f"user:{user_a}"


@pytest.mark.asyncio
async def test_guest_cannot_hijack_member_conversation(db_session):
    """비회원이 회원 conversation_id 를 알아도 이어갈 수 없음(신규 대화 발급)."""
    user_a = str(uuid.uuid4())
    ra = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id=None,
        db=db_session,
        user_id=user_a,
    )
    cid_a = ra.conversation_id

    rg = await cs.handle_chat_message(
        message="결제 수단",
        conversation_id=cid_a,
        db=db_session,
        user_id=None,  # 비회원
    )
    assert rg.conversation_id != cid_a


@pytest.mark.asyncio
async def test_same_member_continues_conversation(db_session):
    """동일 회원은 자신의 conversation_id 를 이어갈 수 있음."""
    user_a = str(uuid.uuid4())
    ra = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id=None,
        db=db_session,
        user_id=user_a,
    )
    cid = ra.conversation_id

    ra2 = await cs.handle_chat_message(
        message="결제 수단",
        conversation_id=cid,
        db=db_session,
        user_id=user_a,
    )
    assert ra2.conversation_id == cid


@pytest.mark.asyncio
async def test_unknown_conversation_id_starts_fresh(db_session):
    """미존재 conversation_id → 신규 발급(서버 발급 uuid4만 신뢰)."""
    resp = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id="client-forged-id-does-not-exist",
        db=db_session,
        user_id=None,
    )
    assert resp.conversation_id != "client-forged-id-does-not-exist"
    # uuid4 형태
    uuid.UUID(resp.conversation_id)


# ── 회귀: escalation / FAQ / whitespace ──────────────────────────────────────


@pytest.mark.asyncio
async def test_escalation_regression(db_session):
    resp = await cs.handle_chat_message(
        message="상담원 연결해주세요",
        conversation_id=None,
        db=db_session,
        user_id=None,
    )
    assert resp.escalated is True
    assert resp.tier == 0


@pytest.mark.asyncio
async def test_faq_tier0_regression(db_session):
    resp = await cs.handle_chat_message(
        message="환불 어떻게 하나요",
        conversation_id=None,
        db=db_session,
        user_id=None,
    )
    assert resp.tier == 0
    assert "환불" in resp.response
