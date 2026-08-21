import uuid

import pytest

from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


@pytest.mark.asyncio
async def test_apply_to_lottery(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()
    tier_id = tier["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["group_size"] == 1
    assert data["result"] is not None
    assert "id" in data
    assert "pool_id" in data
    assert "user_id" in data


@pytest.mark.asyncio
async def test_apply_duplicate_returns_400(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_apply_rejects_tier_from_another_event(client):
    """The event path and tier must describe the same lottery pool."""
    org_token = await get_auth_token(
        client, email="org-cross-tier@test.com", is_organizer=True
    )
    event_a = await create_event_as_organizer(client, org_token)
    event_b = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event_b['id']}/tiers",
        json={
            "name": "OTHER",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    buyer_token = await get_auth_token(client, email="buyer-cross-tier@test.com")

    response = await client.post(
        f"/api/v1/events/{event_a['id']}/tiers/{tier_resp.json()['id']}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )

    assert response.status_code == 400
    assert "does not belong" in response.json()["detail"]


@pytest.mark.asyncio
async def test_apply_without_auth_returns_401(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_lottery_status(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/status",
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_applicants"] == 1
    assert data["total_seats"] == 10
    assert data["status"] is not None


@pytest.mark.asyncio
async def test_draw_lottery_as_organizer(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["winners"] == 1
    assert data["waitlisted"] == 0
    assert "pool_id" in data
    assert "seed_used" in data


@pytest.mark.asyncio
async def test_draw_lottery_non_organizer_forbidden(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_multiple_applicants_draw(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_tokens = []
    for i in range(3):
        token = await get_auth_token(client, email=f"buyer{i}@test.com")
        buyer_tokens.append(token)

    for token in buyer_tokens:
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
            json={"group_size": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    status_resp = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/status",
    )
    assert status_resp.status_code == 200
    assert status_resp.json()["total_applicants"] == 3

    draw_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200
    data = draw_resp.json()
    assert data["winners"] == 3
    assert data["waitlisted"] == 0
    assert "seed_used" in data


@pytest.mark.asyncio
async def test_draw_uses_live_available_seats_when_seat_records_exist(client):
    """docs §4-1: draw() 시점에 실시간 Seat AVAILABLE 카운트 사용.

    시나리오: tier capacity=10, Seat 레코드 10개 중 3개는 SOLD (이전 phase 결제 완료),
    7개는 AVAILABLE. 응모자 10명, quota 없이 draw 하면 **7명만** 당첨되어야 함.
    (pool.total_seats=10 snapshot 사용하면 10명 다 뽑히는 버그 확인.)
    """
    from app.models.event import EventStatus
    from app.models.seat import Seat, SeatStatus

    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]
    event_id = event["id"]

    # go sync 시뮬레이션: 개별 Seat 레코드 10개 생성 (3개 SOLD, 7개 AVAILABLE)
    async with TestSession() as session:
        for i in range(10):
            seat_status = SeatStatus.SOLD if i < 3 else SeatStatus.AVAILABLE
            session.add(
                Seat(
                    id=uuid.uuid4(),
                    event_id=uuid.UUID(event_id),
                    tier_id=uuid.UUID(tier_id),
                    section="A",
                    row_number=1,
                    seat_number=i + 1,
                    status=seat_status,
                )
            )
        await session.commit()

    # 응모자 10명 (tier capacity 만큼)
    for i in range(10):
        token = await get_auth_token(client, email=f"applicant{i}@test.com")
        resp = await client.post(
            f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
            json={"group_size": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200
    data = draw_resp.json()
    # pool snapshot은 10이지만 실제 AVAILABLE은 7 → 7명만 당첨
    assert data["winners"] == 7, f"expected 7 winners from 7 available seats, got {data['winners']}"
    assert data["waitlisted"] == 3


@pytest.mark.asyncio
async def test_draw_respects_max_winners_quota_hint(client):
    """quota(max_winners) 상한: phase별 배분 의도 존중.

    시나리오: tier capacity=10, AVAILABLE=10, 응모자 10명, max_winners=4 (phase quota).
    → 4명만 당첨, 6석은 다음 phase로 이월.
    """
    from app.services.lottery_service import LotteryService
    from app.models.lottery import LotteryPool, LotteryPoolStatus
    from app.models.seat import Seat, SeatStatus
    from sqlalchemy import select as _select

    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]
    event_id = event["id"]

    # 모든 좌석 AVAILABLE
    async with TestSession() as session:
        for i in range(10):
            session.add(
                Seat(
                    id=uuid.uuid4(),
                    event_id=uuid.UUID(event_id),
                    tier_id=uuid.UUID(tier_id),
                    section="A",
                    row_number=1,
                    seat_number=i + 1,
                    status=SeatStatus.AVAILABLE,
                )
            )
        await session.commit()

    for i in range(10):
        token = await get_auth_token(client, email=f"qapplicant{i}@test.com")
        resp = await client.post(
            f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
            json={"group_size": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    # phase-transition webhook과 동일하게 max_winners=4로 직접 draw
    async with TestSession() as session:
        pool = (
            await session.execute(
                _select(LotteryPool).where(
                    LotteryPool.event_id == uuid.UUID(event_id),
                    LotteryPool.tier_id == uuid.UUID(tier_id),
                    LotteryPool.status == LotteryPoolStatus.OPEN,
                )
            )
        ).scalar_one()
        svc = LotteryService(session)
        result = await svc.draw(pool_id=pool.id, max_winners=4)
        await session.commit()

    assert result.winners == 4, f"quota=4 must cap winners, got {result.winners}"
    assert result.waitlisted == 6


async def _create_lottery_event_with_tier(client, org_token, *, capacity=10):
    """Helper: 이벤트 + point_lottery tier 생성 후 (event_id, tier_id) 반환."""
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": capacity,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    return event["id"], tier_resp.json()["id"]


@pytest.mark.asyncio
async def test_draw_lottery_other_organizer_forbidden(client):
    """#10: 타인 이벤트 draw — organizer 플래그만으로는 추첨 불가 (소유권 검증, 403)."""
    org_token = await get_auth_token(client, email="org_owner@test.com", is_organizer=True)
    event_id, tier_id = await _create_lottery_event_with_tier(client, org_token)

    buyer_token = await get_auth_token(client, email="buyer_own@test.com")
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201

    # 다른 organizer (이벤트 미소유) 가 추첨 시도 → 403
    other_org_token = await get_auth_token(
        client, email="org_other@test.com", is_organizer=True
    )
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(other_org_token),
    )
    assert resp.status_code == 403

    # 풀은 그대로 OPEN — 조기 마감되지 않아야 함
    status_resp = await client.get(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status",
    )
    assert status_resp.json()["status"] == "open"

    # 소유 organizer 는 정상 추첨 가능
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_draw_lottery_before_deadline_blocked(client):
    """#10: 응모 마감(bidding_closes_at) 이전 조기 추첨 차단 (400).

    deadline 가드는 apply() 의 phase 가드와 동일하게 PYTEST 환경에서 skip 되므로,
    draw 호출 동안만 PYTEST_CURRENT_TEST 를 제거해 실제 동작을 검증한다.
    (테스트 이벤트 기본 fixture: bidding_closes_at = now + 24h → 마감 전)
    """
    import os

    org_token = await get_auth_token(client, email="org_ddl@test.com", is_organizer=True)
    event_id, tier_id = await _create_lottery_event_with_tier(client, org_token)

    buyer_token = await get_auth_token(client, email="buyer_ddl@test.com")
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201

    saved = os.environ.pop("PYTEST_CURRENT_TEST", None)
    try:
        resp = await client.post(
            f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
            headers=auth_headers(org_token),
        )
    finally:
        if saved is not None:
            os.environ["PYTEST_CURRENT_TEST"] = saved

    assert resp.status_code == 400
    assert "마감" in resp.json()["detail"]

    # 풀은 그대로 OPEN
    status_resp = await client.get(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status",
    )
    assert status_resp.json()["status"] == "open"


@pytest.mark.asyncio
async def test_draw_lottery_cancelled_event_blocked(client):
    """#11: 취소된 이벤트는 (소유자라도) 추첨 실행 불가 — 서비스 레벨 가드 (400)."""
    from app.models.event import Event, EventStatus
    from sqlalchemy import select as _select

    org_token = await get_auth_token(client, email="org_cxl@test.com", is_organizer=True)
    event_id, tier_id = await _create_lottery_event_with_tier(client, org_token)

    buyer_token = await get_auth_token(client, email="buyer_cxl@test.com")
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201

    # 이벤트 취소 상태로 전이 (풀은 OPEN 으로 남은 상황 재현)
    async with TestSession() as session:
        event = (
            await session.execute(_select(Event).where(Event.id == uuid.UUID(event_id)))
        ).scalar_one()
        event.status = EventStatus.CANCELLED
        await session.commit()

    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 400
    assert "취소" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_event_cancel_closes_pool_and_refunds_invested_ap(client):
    """#11: 이벤트 취소 시 미추첨 풀 CLOSED 전이 + 응모자 투자 AP 전액 환급."""
    from app.models.lottery import LotteryPool, LotteryPoolStatus
    from app.models.point import PointTransactionType, PointType
    from app.models.user import User
    from app.services.point_service import PointService
    from sqlalchemy import select as _select

    org_token = await get_auth_token(client, email="org_cxl2@test.com", is_organizer=True)
    event_id, tier_id = await _create_lottery_event_with_tier(client, org_token)

    buyer_email = "buyer_cxl2@test.com"
    buyer_token = await get_auth_token(client, email=buyer_email)

    # 응모자에게 AP 지급 후 500 AP 투자 응모
    async with TestSession() as session:
        buyer = (
            await session.execute(_select(User).where(User.email == buyer_email))
        ).scalar_one()
        buyer_id = buyer.id
        await PointService(session).earn(
            user_id=buyer_id,
            point_type=PointType.FAN,
            amount=500,
            tx_type=PointTransactionType.ADMIN_ADJUST,
            description="test grant",
        )
        await session.commit()
        # 가입 보너스(100) 등 기존 잔액과 무관하게 상대값으로 검증
        balance_before_apply = await PointService(session).get_balance(
            buyer_id, PointType.FAN
        )

    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 500},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201

    async with TestSession() as session:
        balance_after_apply = await PointService(session).get_balance(
            buyer_id, PointType.FAN
        )
    assert balance_after_apply == balance_before_apply - 500

    # 이벤트 취소 (soft-delete: BIDDING_OPEN → CANCELLED)
    resp = await client.delete(
        f"/api/v1/events/{event_id}",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == "Event cancelled"
    assert body["lottery"]["pools_closed"] == 1
    assert body["lottery"]["entries_refunded"] == 1
    assert body["lottery"]["ap_refunded"] == 500

    async with TestSession() as session:
        # 풀이 CLOSED 로 전이되어 자동 추첨(OPEN 풀 선별) 대상에서 제외됨
        pool = (
            await session.execute(
                _select(LotteryPool).where(
                    LotteryPool.event_id == uuid.UUID(event_id)
                )
            )
        ).scalar_one()
        assert pool.status == LotteryPoolStatus.CLOSED

        # 투자 AP 전액 환급 — 응모 전 잔액으로 복원
        balance = await PointService(session).get_balance(buyer_id, PointType.FAN)
        assert balance == balance_before_apply
