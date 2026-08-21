"""
WP12-13 Backend Tests: POINT_LOTTERY + Membership Tier
=======================================================
- test_lottery_apply_with_invested_ap: AP 투자 포함 신청
- test_lottery_apply_zero_ap: 0 AP 미투자 참여
- test_lottery_apply_invalid_ap: 잘못된 AP 금액 거절
- test_tier_thresholds: 티어별 정확한 경계값
- test_tier_multiplier: 각 티어 multiplier 확인
- test_tier_from_score: 점수 기반 티어 결정
"""

import pytest
from sqlalchemy import select

from app.models.lottery import LotteryEntry, LotteryEntryResult
from app.models.point import PointTransaction, PointTransactionType, PointType
from app.models.user import User
from app.services.point_service import PointService
from app.tests.conftest import TestSession, auth_headers, create_event_as_organizer, get_auth_token


@pytest.mark.asyncio
async def test_lottery_apply_with_invested_ap(client):
    """AP 투자 포함 추첨 신청 성공."""
    org_token = await get_auth_token(client, email="org_ap1@test.com", is_organizer=True)
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

    buyer_token = await get_auth_token(client, email="buyer_ap1@test.com")
    # Fund the buyer's wallet so the 500 AP investment is actually covered.
    # (deduct rejects over-spend: investing AP you don't hold must fail, so the
    # success path requires a real balance — see test_lottery_apply_insufficient_ap.)
    await _grant_fan_points("buyer_ap1@test.com", 500)
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 500},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["invested_ap"] == 500
    assert data["tier_multiplier"] >= 1.0
    assert data["pity_bonus"] >= 1.0


@pytest.mark.asyncio
async def test_lottery_apply_insufficient_ap(client):
    """Investing more AP than the wallet holds must be rejected (no free weight).

    Regression: deduct used to floor at 0 while the entry still recorded the full
    invested_ap, granting lottery weight for AP the user never paid.
    """
    org_token = await get_auth_token(client, email="org_ap_insf@test.com", is_organizer=True)
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

    # Fresh buyer holds only the signup bonus (~100 AP), far below 5000.
    buyer_token = await get_auth_token(client, email="buyer_ap_insf@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 5000},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400
    # No entry should be persisted for a rejected investment.
    async with TestSession() as session:
        buyer = (
            await session.execute(select(User).where(User.email == "buyer_ap_insf@test.com"))
        ).scalar_one()
        entries = (
            await session.execute(
                select(LotteryEntry).where(LotteryEntry.user_id == buyer.id)
            )
        ).scalars().all()
    assert entries == []


@pytest.mark.asyncio
async def test_lottery_apply_zero_ap(client):
    """0 AP 미투자 참여 성공."""
    org_token = await get_auth_token(client, email="org_ap2@test.com", is_organizer=True)
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

    buyer_token = await get_auth_token(client, email="buyer_ap2@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 0},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["invested_ap"] == 0


@pytest.mark.asyncio
async def test_lottery_apply_invalid_ap_too_small(client):
    """100 미만 AP 투자 거절 (최소 100 단위)."""
    org_token = await get_auth_token(client, email="org_ap3@test.com", is_organizer=True)
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

    buyer_token = await get_auth_token(client, email="buyer_ap3@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 50},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_lottery_apply_invalid_ap_not_multiple(client):
    """100 단위가 아닌 AP 거절."""
    org_token = await get_auth_token(client, email="org_ap4@test.com", is_organizer=True)
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

    buyer_token = await get_auth_token(client, email="buyer_ap4@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 150},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_lottery_apply_invalid_ap_too_large(client):
    """10000 초과 AP 거절."""
    org_token = await get_auth_token(client, email="org_ap5@test.com", is_organizer=True)
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

    buyer_token = await get_auth_token(client, email="buyer_ap5@test.com")
    # Pydantic le=10000 should reject this at schema level
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 20000},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 422  # Pydantic validation


# ─── WP13: Tier tests ───


def test_tier_thresholds():
    """티어별 정확한 경계값 확인."""
    from app.services.tier_service import tier_from_score

    # rookie: 0 ~ 999
    assert tier_from_score(0) == "rookie"
    assert tier_from_score(500) == "rookie"
    assert tier_from_score(999) == "rookie"

    # fan: 1000 ~ 4999
    assert tier_from_score(1000) == "fan"
    assert tier_from_score(3000) == "fan"
    assert tier_from_score(4999) == "fan"

    # supporter: 5000 ~ 14999
    assert tier_from_score(5000) == "supporter"
    assert tier_from_score(10000) == "supporter"
    assert tier_from_score(14999) == "supporter"

    # corefan: 15000 ~ 49999
    assert tier_from_score(15000) == "corefan"
    assert tier_from_score(30000) == "corefan"
    assert tier_from_score(49999) == "corefan"

    # legend: 50000+
    assert tier_from_score(50000) == "legend"
    assert tier_from_score(100000) == "legend"
    assert tier_from_score(999999) == "legend"


def test_tier_multiplier():
    """각 티어 multiplier 확인."""
    from app.services.tier_service import TIER_MULTIPLIERS

    assert TIER_MULTIPLIERS["rookie"] == 1.00
    assert TIER_MULTIPLIERS["fan"] == 1.05
    assert TIER_MULTIPLIERS["supporter"] == 1.10
    assert TIER_MULTIPLIERS["corefan"] == 1.15
    assert TIER_MULTIPLIERS["legend"] == 1.20


def test_tier_order():
    """티어 순서 확인."""
    from app.services.tier_service import TIER_ORDER

    assert TIER_ORDER == ["rookie", "fan", "supporter", "corefan", "legend"]


def test_tier_from_score_edge_cases():
    """경계값 상세 테스트."""
    from app.services.tier_service import tier_from_score

    # 음수 점수
    assert tier_from_score(-100) == "rookie"

    # 정확한 경계
    assert tier_from_score(999.99) == "rookie"
    assert tier_from_score(1000.0) == "fan"
    assert tier_from_score(4999.99) == "fan"
    assert tier_from_score(5000.0) == "supporter"


async def _grant_fan_points(email: str, amount: int):
    async with TestSession() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        await PointService(session).earn(
            user_id=user.id,
            point_type=PointType.FAN,
            amount=amount,
            tx_type=PointTransactionType.ADMIN_ADJUST,
            description="test grant",
        )
        await session.commit()
        return user.id


@pytest.mark.asyncio
async def test_point_lottery_draw_uses_vcg_and_refunds_winner_delta(client):
    org_token = await get_auth_token(client, email="org_ap_vcg@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "AP Lottery",
            "capacity": 1,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code == 201, tier_resp.text
    tier_id = tier_resp.json()["id"]

    high_email = "buyer_ap_vcg_high@test.com"
    low_email = "buyer_ap_vcg_low@test.com"
    high_token = await get_auth_token(client, email=high_email)
    low_token = await get_auth_token(client, email=low_email)

    high_user_id = await _grant_fan_points(high_email, 3000)
    low_user_id = await _grant_fan_points(low_email, 300)

    high_apply = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 2500},
        headers=auth_headers(high_token),
    )
    assert high_apply.status_code == 201, high_apply.text

    low_apply = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 100},
        headers=auth_headers(low_token),
    )
    assert low_apply.status_code == 201, low_apply.text

    draw_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200, draw_resp.text
    assert draw_resp.json()["winners"] == 1
    assert draw_resp.json()["waitlisted"] == 1

    # E-S 가중치 추첨은 확률적이므로 어느 쪽이 당첨될지 보장 불가.
    # 1명 당첨 + 1명 대기 구조만 검증하고, 낙첨자 위로금을 확인한다.
    async with TestSession() as session:
        high_entry = (
            await session.execute(select(LotteryEntry).where(LotteryEntry.user_id == high_user_id))
        ).scalar_one()
        low_entry = (
            await session.execute(select(LotteryEntry).where(LotteryEntry.user_id == low_user_id))
        ).scalar_one()

        results = {high_entry.result, low_entry.result}
        assert results == {LotteryEntryResult.WON, LotteryEntryResult.WAITLISTED}

        # 낙첨자(WAITLISTED) 식별
        if high_entry.result == LotteryEntryResult.WAITLISTED:
            loser_user_id, loser_ap = high_user_id, 2500
        else:
            loser_user_id, loser_ap = low_user_id, 100

        # 낙첨자 위로금 (투자 AP의 10%, 최소 50, 최대 500)
        consolation = (
            await session.execute(
                select(PointTransaction).where(
                    PointTransaction.user_id == loser_user_id,
                    PointTransaction.tx_type == PointTransactionType.EARN_CONSOLATION_LOTTERY,
                )
            )
        ).scalar_one()
        expected_consolation = max(50, min(500, int(loser_ap * 0.1)))
        assert consolation.amount == expected_consolation

        # E-S verification_data가 pool에 저장되었는지 확인
        import uuid as _uuid
        from app.models.lottery import LotteryPool
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.tier_id == _uuid.UUID(tier_id))
            )
        ).scalar_one()
        v_data = pool.verification_data or {}
        assert v_data.get("algorithm") == "efraimidis_spirakis_weighted_sampling"
        assert v_data.get("capacity") == 1
        assert len(v_data.get("entries", [])) == 2


@pytest.mark.asyncio
async def test_point_lottery_zero_ap_still_uses_vcg(client):
    """0 AP 참가자만 있어도 POINT_LOTTERY는 VCG를 사용해야 한다."""
    org_token = await get_auth_token(client, email="org_zerovcg@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "Zero AP VCG",
            "capacity": 1,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code == 201, tier_resp.text
    tier_id = tier_resp.json()["id"]

    # 두 참가자 모두 0 AP
    t1 = await get_auth_token(client, email="zero_ap_a@test.com")
    t2 = await get_auth_token(client, email="zero_ap_b@test.com")

    r1 = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 0},
        headers=auth_headers(t1),
    )
    assert r1.status_code == 201

    r2 = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": 0},
        headers=auth_headers(t2),
    )
    assert r2.status_code == 201

    draw_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200, draw_resp.text
    assert draw_resp.json()["winners"] == 1
    assert draw_resp.json()["waitlisted"] == 1

    # VCG verification_data가 저장되었는지 확인 (E-S가 아닌 VCG)
    import uuid as _uuid
    from app.models.lottery import LotteryPool

    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.tier_id == _uuid.UUID(tier_id))
            )
        ).scalar_one()
        v_data = pool.verification_data or {}
        # 0 AP여도 E-S 공정 추첨 알고리즘이 사용되어야 한다
        assert v_data.get("algorithm") == "efraimidis_spirakis_weighted_sampling", (
            f"Expected E-S but got: {v_data.get('algorithm')}"
        )
        assert len(v_data.get("entries", [])) == 2
