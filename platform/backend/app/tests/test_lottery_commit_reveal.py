"""
Lottery Commit-Reveal v2 Tests (F-1)
=====================================
사전(pre-draw) 시드 커밋 + 사후(post-draw) reveal/결과 바인딩 검증.

체계:
  ① 커밋: 풀 생성 시 server_seed(비공개) + seed_commitment(공개) 영속화
  ② 추첨: draw 는 사전 커밋된 server_seed 만 사용 (커밋 없는 풀은 거부,
     legacy 풀은 별도 트랜잭션 백필 후 추첨)
  ③ 공개/검증: server_seed reveal + 엔트리 스냅샷 digest + 당첨자 목록을
     result_hash 로 바인딩 → verify 가 커밋 일치 + 추첨 재계산 일치 확인
  ④ legacy(사후 커밋 시절) 데이터는 is_legacy=true 로 구분 응답
"""

import uuid

import pytest
from sqlalchemy import select

from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


async def _setup_pool_with_applicants(client, *, n_applicants=5, capacity=10, prefix="cr"):
    """이벤트 + point_lottery tier 생성, n명 응모. (event_id, tier_id, org_token) 반환."""
    org_token = await get_auth_token(client, email=f"org_{prefix}@test.com", is_organizer=True)
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
    assert tier_resp.status_code in (200, 201)
    tier_id = tier_resp.json()["id"]

    for i in range(n_applicants):
        token = await get_auth_token(client, email=f"{prefix}_buyer{i}@test.com")
        body = {"group_size": 1}
        if i == 0:
            body["client_seed"] = f"{prefix}_client_seed_0"
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
            json=body,
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    return event["id"], tier_id, org_token


@pytest.mark.asyncio
async def test_commitment_published_before_draw(client):
    """① 커밋 단계: 추첨 전(OPEN) 풀 상태에 seed_commitment 가 공개되고,
    server_seed 는 어디에도 노출되지 않아야 한다."""
    event_id, tier_id, _ = await _setup_pool_with_applicants(client, prefix="pub")

    resp = await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "open"
    # 사전 커밋이 추첨 전에 공개 조회 가능
    assert isinstance(data["seed_commitment"], str) and len(data["seed_commitment"]) == 64
    assert data["committed_at"] is not None
    # 비공개 시드는 응답에 없어야 함 (reveal 은 추첨 후 verify 에서만)
    assert "server_seed" not in data
    assert data["seed_used"] is None


@pytest.mark.asyncio
async def test_verify_v2_full_flow(client):
    """②③ 추첨이 사전 커밋 시드를 사용하고, verify 가 커밋 일치 +
    추첨 재계산 일치 + 커밋 선행을 모두 확인한다."""
    from app.models.lottery import LotteryPool

    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=6, capacity=3, prefix="v2"
    )

    # 추첨 전: 공개 커밋 + DB의 비공개 시드 기록
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pre_commitment = status["seed_commitment"]
    pool_id = status["id"]
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        pre_server_seed = pool.server_seed
        assert pre_server_seed is not None
        assert pool.seed_commitment == pre_commitment
        assert pool.drawn_at is None

    # 추첨
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    # 검증
    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    assert verify["is_legacy"] is False
    assert verify["is_valid"] is True
    # 커밋은 추첨으로 변경되지 않아야 함 (사전 커밋 그대로)
    assert verify["seed_commitment"] == pre_commitment
    # reveal: 추첨에 사용된 server_seed 가 사전 저장된 시드와 일치
    assert verify["server_seed"] == pre_server_seed
    # 개별 검증 항목
    checks = verify["checks"]
    assert checks["commitment_valid"] is True
    assert checks["entries_digest_valid"] is True
    assert checks["winners_match"] is True
    assert checks["result_hash_valid"] is True
    assert checks["commit_precedes_draw"] is True
    assert verify["committed_at"] < verify["drawn_at"]
    # 공개 데이터에 결과 바인딩 필드 존재
    vd = verify["verification_data"]
    assert vd["scheme"] == "commit_reveal_v2"
    assert vd["seed_commitment"] == pre_commitment
    assert vd["entries_digest"]
    assert vd["result_hash"]
    assert isinstance(vd["winners"], list) and len(vd["winners"]) == 3


@pytest.mark.asyncio
async def test_third_party_can_independently_verify(client):
    """verify 엔드포인트 응답만으로 제3자(엔진 패키지 사용)가 독립 재검증 가능."""
    from talkfile_engine.lottery import LotteryVerifier

    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=6, capacity=2, prefix="tp"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    pre_commitment = status["seed_commitment"]

    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    checks = LotteryVerifier.verify_reveal(
        pre_commitment, pool_id, verify["verification_data"]
    )
    assert checks["is_valid"] is True


@pytest.mark.asyncio
async def test_verify_detects_tampered_winners(client):
    """사후 당첨자 치환은 winners_match/result_hash 불일치로 탐지."""
    from app.models.lottery import LotteryPool

    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=6, capacity=2, prefix="tamper"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    # DB에서 당첨자 목록 직접 변조 (악의적 운영자 시뮬레이션)
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        vd = dict(pool.verification_data)
        winners = list(vd["winners"])
        losers = [w for w in vd["waitlist"]]
        assert losers, "테스트 전제: 낙첨자 존재"
        winners[0] = losers[0]
        vd["winners"] = winners
        pool.verification_data = vd
        await session.commit()

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_valid"] is False
    assert verify["checks"]["winners_match"] is False
    assert verify["checks"]["result_hash_valid"] is False


@pytest.mark.asyncio
async def test_verify_detects_seed_reroll(client):
    """추첨 후 server_seed 재추첨(reveal 교체)은 commitment 불일치로 탐지."""
    from app.models.lottery import LotteryPool

    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=5, capacity=2, prefix="reroll"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        vd = dict(pool.verification_data)
        vd["server_seed"] = (vd["server_seed"] + 1) % (2**63)
        pool.verification_data = vd
        pool.server_seed = vd["server_seed"]
        await session.commit()

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_valid"] is False
    assert verify["checks"]["commitment_valid"] is False


@pytest.mark.asyncio
async def test_legacy_post_hoc_pool_flagged(client):
    """과거(사후 커밋 시절) 데이터는 is_legacy=true + legacy scheme 으로 구분 응답."""
    from app.models.lottery import LotteryPool

    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=4, capacity=2, prefix="legacy"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    # legacy 데이터로 강등: v2 컬럼/키 제거 (마이그레이션 이전 데이터 시뮬레이션)
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        vd = dict(pool.verification_data)
        for key in (
            "scheme", "server_seed", "entries_digest", "winners", "waitlist",
            "tier_id", "pool_id", "seed_commitment", "committed_at", "result_hash",
        ):
            vd.pop(key, None)
        pool.verification_data = vd
        pool.seed_commitment = None
        pool.server_seed = None
        pool.committed_at = None
        pool.drawn_at = None
        await session.commit()

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_legacy"] is True
    assert verify["scheme"] == "legacy_post_hoc_commit"
    # 해시 무결성 자체는 유지 — 단 사전 커밋 증명이 아님이 명시됨
    assert verify["is_valid"] is True
    assert "legacy_hash_match" in verify["checks"]
    assert verify["server_seed"] is None
    assert verify["seed_commitment"] is None

    # 투명성 리포트도 legacy 구분
    report = (
        await client.get(f"/api/v1/lottery/pools/{pool_id}/transparency-report")
    ).json()
    assert report["scheme"] == "legacy_post_hoc_commit"


@pytest.mark.asyncio
async def test_legacy_open_pool_draw_backfills_commitment_then_draws(client):
    """커밋 없는 legacy OPEN 풀: draw 가 커밋을 백필(별도 트랜잭션)한 뒤
    그 시드로 추첨 — 결과는 v2 검증을 통과해야 한다."""
    from app.models.lottery import LotteryPool
    from app.services.lottery_service import LotteryService

    event_id, tier_id, _ = await _setup_pool_with_applicants(
        client, n_applicants=5, capacity=2, prefix="backfill"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = uuid.UUID(status["id"])

    # 마이그레이션 이전 풀 시뮬레이션: 커밋 컬럼 제거
    async with TestSession() as session:
        pool = (
            await session.execute(select(LotteryPool).where(LotteryPool.id == pool_id))
        ).scalar_one()
        pool.seed_commitment = None
        pool.server_seed = None
        pool.committed_at = None
        await session.commit()

    async with TestSession() as session:
        svc = LotteryService(session)
        result = await svc.draw(pool_id=pool_id)
        await session.commit()
    assert result.winners == 2

    async with TestSession() as session:
        pool = (
            await session.execute(select(LotteryPool).where(LotteryPool.id == pool_id))
        ).scalar_one()
        assert pool.seed_commitment is not None
        assert pool.committed_at is not None
        assert pool.drawn_at is not None

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    assert verify["is_valid"] is True


@pytest.mark.asyncio
async def test_draw_inner_rejects_pool_without_commitment(client):
    """_draw_inner 는 사전 커밋 없는 풀을 거부한다 — 커밋이 draw 와 같은
    트랜잭션에서 생성되는 사후 커밋 경로가 코드상 존재하지 않음을 보장."""
    from app.models.lottery import LotteryPool
    from app.services.lottery_service import LotteryService

    event_id, tier_id, _ = await _setup_pool_with_applicants(
        client, n_applicants=3, capacity=2, prefix="reject"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = uuid.UUID(status["id"])

    async with TestSession() as session:
        pool = (
            await session.execute(select(LotteryPool).where(LotteryPool.id == pool_id))
        ).scalar_one()
        pool.seed_commitment = None
        pool.server_seed = None
        pool.committed_at = None
        await session.commit()

    async with TestSession() as session:
        svc = LotteryService(session)
        with pytest.raises(ValueError, match="사전 시드 커밋"):
            await svc._draw_inner(pool_id)
        await session.rollback()


async def _grant_guaranteed_tickets(emails, *, domain="concert"):
    """주어진 이메일 사용자들에게 domain-level 보장 당첨권(pity)을 발급."""
    from datetime import datetime, timedelta, timezone

    from app.models.pity import PityTracker
    from app.models.user import User

    async with TestSession() as session:
        for email in emails:
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one()
            session.add(
                PityTracker(
                    user_id=user.id,
                    domain=domain,
                    artist_id=None,
                    consecutive_losses=10,
                    guaranteed_ticket=True,
                    guaranteed_expires_at=datetime.now(timezone.utc)
                    + timedelta(days=30),
                )
            )
        await session.commit()


@pytest.mark.asyncio
async def test_pity_exhausted_pool_verifies_as_v2(client):
    """보장당첨(pity) 보유자만으로 좌석이 전부 소진된 풀(엔진 draw 스킵)도
    verify 가 v2(commit_reveal_v2) 로 분류하고 is_valid=True 를 반환한다.

    회귀 방지: 이전에는 verification_data 가 {} 로 남아 legacy + is_valid=False
    로 오분류됐다."""
    from app.models.lottery import LotteryPool

    prefix = "pityok"
    # 좌석 2석, 응모자 3명 — 그 중 2명이 보장당첨자 → 좌석 전소진, 엔진 draw 스킵
    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=3, capacity=2, prefix=prefix
    )
    await _grant_guaranteed_tickets([f"{prefix}_buyer0@test.com", f"{prefix}_buyer1@test.com"])

    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    pre_commitment = status["seed_commitment"]

    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    assert verify["is_legacy"] is False
    assert verify["is_valid"] is True
    assert verify["seed_commitment"] == pre_commitment
    assert verify["server_seed"] is not None

    checks = verify["checks"]
    assert checks["commitment_valid"] is True
    assert checks["entries_digest_valid"] is True
    assert checks["winners_match"] is True
    assert checks["result_hash_valid"] is True
    assert checks["commit_precedes_draw"] is True

    vd = verify["verification_data"]
    assert vd["scheme"] == "commit_reveal_v2"
    assert vd["draw_mode"] == "pity_exhausted"
    assert vd["entries_digest"]
    assert vd["result_hash"]
    # 좌석 2석 모두 보장당첨자가 차지
    assert isinstance(vd["winners"], list) and len(vd["winners"]) == 2

    # 엔진 draw 스킵 → DB에 v2 reveal 기록이 채워졌는지 직접 확인
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        assert pool.verification_data.get("scheme") == "commit_reveal_v2"
        assert pool.verification_data.get("draw_mode") == "pity_exhausted"


@pytest.mark.asyncio
async def test_pity_exhausted_detects_tampered_winners(client):
    """pity 소진 풀에서도 사후 당첨자 치환은 winners_match/result_hash 불일치로
    탐지된다 (보장당첨자 목록 == 기록 불변 검증)."""
    from app.models.lottery import LotteryPool

    prefix = "pitytamper"
    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=3, capacity=2, prefix=prefix
    )
    await _grant_guaranteed_tickets([f"{prefix}_buyer0@test.com", f"{prefix}_buyer1@test.com"])

    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    # 정상 검증 선확인
    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_valid"] is True
    real_winner = verify["verification_data"]["winners"][0]

    # 보장당첨자 목록을 비당첨자(존재하지 않는 user)로 치환
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        vd = dict(pool.verification_data)
        winners = list(vd["winners"])
        winners[0] = str(uuid.uuid4())  # 기록에 없던 user 로 치환
        assert winners[0] != real_winner
        vd["winners"] = winners
        pool.verification_data = vd
        await session.commit()

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    assert verify["is_valid"] is False
    assert verify["checks"]["winners_match"] is False
    assert verify["checks"]["result_hash_valid"] is False


@pytest.mark.asyncio
async def test_mixed_pity_and_engine_pool_verifies_as_v2(client):
    """혼합 케이스: 일부 좌석은 보장(pity)당첨자, 나머지는 엔진 가중 추첨.

    보장당첨자가 verification_data['guaranteed_winners'] 로 기록되고 result_hash
    에 바인딩되어, verify 가 엔진 재추첨(winners_match) + 보장당첨자 바인딩
    (result_hash_valid) 을 모두 통과해 is_valid=True 여야 한다."""
    from app.models.lottery import LotteryPool

    prefix = "mixedok"
    # 좌석 5석, 응모자 5명 — 그 중 2명이 보장당첨자.
    # → 보장 2석 소진, 남은 3석을 비-pity 3명이 엔진 추첨 (혼합)
    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=5, capacity=5, prefix=prefix
    )
    await _grant_guaranteed_tickets(
        [f"{prefix}_buyer0@test.com", f"{prefix}_buyer1@test.com"]
    )

    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]

    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    assert verify["is_legacy"] is False
    assert verify["is_valid"] is True

    checks = verify["checks"]
    assert checks["commitment_valid"] is True
    assert checks["entries_digest_valid"] is True
    assert checks["winners_match"] is True
    assert checks["result_hash_valid"] is True
    assert checks["commit_precedes_draw"] is True

    vd = verify["verification_data"]
    # 엔진 draw 가 실제로 실행됐어야 함 (pity 소진 모드가 아님)
    assert vd.get("draw_mode") != "pity_exhausted"
    # 보장당첨자가 별도 기록되어 result_hash 에 바인딩됨
    guaranteed = vd.get("guaranteed_winners")
    assert isinstance(guaranteed, list) and len(guaranteed) == 2
    # 보장당첨자는 엔진 winners(가중 추첨) 목록과 분리되어 있어야 함
    assert set(guaranteed).isdisjoint(set(vd["winners"]))


@pytest.mark.asyncio
async def test_mixed_pool_detects_guaranteed_winner_tampering(client):
    """혼합 케이스에서 보장당첨자 목록을 사후 변조하면, 엔진 재추첨은 여전히
    일치하더라도 result_hash 불일치로 탐지되어 is_valid=False 가 된다.

    이것이 이번 결함의 핵심 회귀 테스트: 가짜 보장당첨자 주입을 탐지한다."""
    from app.models.lottery import LotteryPool

    prefix = "mixedtamper"
    event_id, tier_id, org_token = await _setup_pool_with_applicants(
        client, n_applicants=5, capacity=5, prefix=prefix
    )
    await _grant_guaranteed_tickets(
        [f"{prefix}_buyer0@test.com", f"{prefix}_buyer1@test.com"]
    )

    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = status["id"]
    draw_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_valid"] is True
    engine_winners_before = list(verify["verification_data"]["winners"])

    # 가짜 보장당첨자 주입 (엔진 winners/시드/엔트리 스냅샷은 그대로)
    async with TestSession() as session:
        pool = (
            await session.execute(
                select(LotteryPool).where(LotteryPool.id == uuid.UUID(pool_id))
            )
        ).scalar_one()
        vd = dict(pool.verification_data)
        guaranteed = list(vd["guaranteed_winners"])
        guaranteed.append(str(uuid.uuid4()))  # 기록에 없던 가짜 당첨자
        vd["guaranteed_winners"] = guaranteed
        pool.verification_data = vd
        await session.commit()

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["scheme"] == "commit_reveal_v2"
    # 엔진 재추첨은 여전히 일치 (보장당첨자는 재추첨 대상 아님)
    assert verify["verification_data"]["winners"] == engine_winners_before
    assert verify["checks"]["winners_match"] is True
    # 보장당첨자 바인딩이 깨져 전체 검증 실패
    assert verify["checks"]["result_hash_valid"] is False
    assert verify["is_valid"] is False


@pytest.mark.asyncio
async def test_ensure_commitment_idempotent(client):
    """ensure_commitment 는 기존 커밋을 절대 교체하지 않는다 (시드 불변)."""
    from app.services.lottery_service import LotteryService

    event_id, tier_id, _ = await _setup_pool_with_applicants(
        client, n_applicants=2, capacity=2, prefix="idem"
    )
    status = (
        await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")
    ).json()
    pool_id = uuid.UUID(status["id"])
    original = status["seed_commitment"]

    async with TestSession() as session:
        svc = LotteryService(session)
        c1 = await svc.ensure_commitment(pool_id)
        c2 = await svc.ensure_commitment(pool_id)
    assert c1 == c2 == original
