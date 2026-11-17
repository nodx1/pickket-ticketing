"""과업 WP2 — Slash(권한 소각) · 계정 복제 차단 · 정상 누적 시간 점수 (DB 통합)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models.fairness import LotteryMerkleLeaf, MerkleKind
from app.models.lottery import LotteryEntry
from app.models.point import PointTransactionType, PointType
from app.models.sanction import AccountSanction, SanctionAction
from app.models.user import User
from app.services.point_service import PointService
from app.services.sanction_service import SanctionError, SanctionService
from app.services.tenure_service import TenureService, tenure_score
from app.tests.conftest import TestSession, auth_headers, create_event_as_organizer, get_auth_token

_TOKENS: dict[str, str] = {}


async def _token(client, email: str) -> str:
    """같은 이메일로 두 번 가입하지 않도록 토큰을 재사용한다."""
    if email not in _TOKENS:
        _TOKENS[email] = await get_auth_token(client, email=email)
    return _TOKENS[email]


async def _uid(email: str) -> uuid.UUID:
    async with TestSession() as s:
        return (await s.execute(select(User.id).where(User.email == email))).scalar_one()


async def _grant(email: str, amount: int) -> uuid.UUID:
    async with TestSession() as s:
        uid = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
        await PointService(s).earn(
            user_id=uid, point_type=PointType.FAN, amount=amount, tx_type=PointTransactionType.ADMIN_ADJUST, description="t"
        )
        await s.commit()
        return uid


async def _setup(client, prefix, capacity=2):
    org = await get_auth_token(client, email=f"org_{prefix}@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org)
    tier = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "S석", "capacity": capacity, "base_price": 100.0, "sale_mode": "point_lottery", "face_price": 100.0},
        headers=auth_headers(org),
    )
    return event["id"], tier.json()["id"], org


async def _apply(client, event_id, tier_id, email, *, ap=0, headers_extra=None):
    token = await _token(client, email)
    if ap:
        await _grant(email, ap)
    headers = {**auth_headers(token), **(headers_extra or {})}
    return await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "invested_ap": ap},
        headers=headers,
    )


# ───────── Slash ─────────


@pytest.mark.asyncio
async def test_slash_burns_ap_blocks_apply_and_excludes_pending_entry(client):
    event_id, tier_id, org = await _setup(client, "sl1", capacity=3)
    resp = await _apply(client, event_id, tier_id, "sl1_bad@test.com", ap=1000)
    assert resp.status_code == 201
    bad = await _uid("sl1_bad@test.com")
    await _grant("sl1_bad@test.com", 400)  # 응모 후 잔액 400
    for i in range(3):
        assert (await _apply(client, event_id, tier_id, f"sl1_ok{i}@test.com")).status_code == 201

    async with TestSession() as s:
        before = await PointService(s).get_balance(bad, PointType.FAN)
        sanction = await SanctionService(s).impose(bad, "macro_bot", event_id=uuid.UUID(event_id), actor="t")
        await s.commit()
        assert sanction.ap_burned == before  # 보유 AP 전액 소각
        assert await PointService(s).get_balance(bad, PointType.FAN) == 0

    # 추첨: 좌석 3 · 정상 응모 3 → 제재 계정은 빠지고 정상 3명이 모두 당첨
    draw = await client.post(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw", headers=auth_headers(org))
    assert draw.status_code == 200, draw.text
    pool_id = (await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")).json()["id"]
    async with TestSession() as s:
        entries = (await s.execute(select(LotteryEntry).where(LotteryEntry.pool_id == uuid.UUID(pool_id)))).scalars().all()
        results = {e.user_id: e.result.value for e in entries}
        assert results[bad] == "waitlisted"
        assert sum(1 for u, r in results.items() if u != bad and r == "won") == 3
        leaf = (
            await s.execute(
                select(LotteryMerkleLeaf).where(
                    LotteryMerkleLeaf.pool_id == uuid.UUID(pool_id),
                    LotteryMerkleLeaf.user_id == bad,
                    LotteryMerkleLeaf.kind == MerkleKind.RESULTS,
                )
            )
        ).scalar_one()
        assert leaf.payload["result"] == "excluded"  # 결과 트리에 제외 사실이 남는다
        # 투입 AP 는 환급되지 않는다(소각)
        assert await PointService(s).get_balance(bad, PointType.FAN) == 0

    # 같은 이벤트 재응모 거부
    tier2 = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json={"name": "A석", "capacity": 5, "base_price": 100.0, "sale_mode": "point_lottery", "face_price": 100.0},
        headers=auth_headers(org),
    )
    again = await _apply(client, event_id, tier2.json()["id"], "sl1_bad@test.com")
    assert again.status_code == 400
    assert "이용이 제한된 계정" in again.json()["detail"]


@pytest.mark.asyncio
async def test_lift_restores_eligibility_and_ledger_is_append_only(client):
    event_id, tier_id, _ = await _setup(client, "sl2")
    await _token(client, "sl2_u@test.com")
    uid = await _uid("sl2_u@test.com")
    async with TestSession() as s:
        sanction = await SanctionService(s).impose(uid, "manual", event_id=uuid.UUID(event_id), burn_ratio=0.0, actor="t")
        await SanctionService(s).lift(sanction.id, actor="t", note="오탐")
        await s.commit()
    assert (await _apply(client, event_id, tier_id, "sl2_u@test.com")).status_code == 201
    async with TestSession() as s:
        rows = (await s.execute(select(AccountSanction).where(AccountSanction.user_id == uid))).scalars().all()
        assert [r.action for r in rows] == [SanctionAction.IMPOSE, SanctionAction.LIFT]  # 원 기록은 그대로


@pytest.mark.asyncio
async def test_expired_sanction_no_longer_blocks(client):
    event_id, tier_id, _ = await _setup(client, "sl3")
    await _token(client, "sl3_u@test.com")
    uid = await _uid("sl3_u@test.com")
    async with TestSession() as s:
        s.add(
            AccountSanction(
                user_id=uid,
                event_id=None,
                action=SanctionAction.IMPOSE,
                reason_code="scalping",
                evidence={},
                ap_burned=0,
                disqualify_until=datetime.now(UTC) - timedelta(days=1),
                created_at=datetime.now(UTC) - timedelta(days=91),
            )
        )
        await s.commit()
    assert (await _apply(client, event_id, tier_id, "sl3_u@test.com")).status_code == 201


@pytest.mark.asyncio
async def test_unknown_reason_rejected(client):
    await _token(client, "sl4_u@test.com")
    uid = await _uid("sl4_u@test.com")
    async with TestSession() as s:
        with pytest.raises(SanctionError):
            await SanctionService(s).impose(uid, "looks_suspicious")


# ───────── 계정 복제 차단 ─────────


@pytest.mark.asyncio
async def test_same_device_third_account_is_blocked_and_flagged(client):
    event_id, tier_id, _ = await _setup(client, "mc1", capacity=10)
    device = {"x-device-fingerprint": "fp-shared-device-0001"}
    assert (await _apply(client, event_id, tier_id, "mc1_a@test.com", headers_extra=device)).status_code == 201
    assert (await _apply(client, event_id, tier_id, "mc1_b@test.com", headers_extra=device)).status_code == 201
    third = await _apply(client, event_id, tier_id, "mc1_c@test.com", headers_extra=device)
    assert third.status_code == 400
    assert "여러 계정" in third.json()["detail"]
    # 다른 기기는 영향 없음
    other = await _apply(client, event_id, tier_id, "mc1_d@test.com", headers_extra={"x-device-fingerprint": "fp-other"})
    assert other.status_code == 201

    third_uid = await _uid("mc1_c@test.com")
    async with TestSession() as s:
        flags = (
            await s.execute(select(AccountSanction).where(AccountSanction.user_id == third_uid, AccountSanction.action == SanctionAction.FLAG))
        ).scalars().all()
        assert flags and flags[0].reason_code == "multi_account"  # 거부돼도 검토 표시는 남는다
        monitor = await SanctionService(s).monitor(uuid.UUID(event_id))
    assert any(i["action"] == "flag" and i["reason_code"] == "multi_account" for i in monitor["items"])
    assert all("user_id" not in i for i in monitor["items"])  # 주최사 화면에 원 id 미노출


# ───────── 정상 누적 시간 ─────────


def test_tenure_score_formula():
    assert tenure_score(0, 0, False) == 0.0
    assert tenure_score(730, 10, False) == 1.0
    assert tenure_score(365, 5, False) == pytest.approx(0.5)
    assert tenure_score(9999, 99, False) == 1.0
    assert tenure_score(730, 10, True) == 0.0  # 최근 제재 → 정상 누적 아님


@pytest.mark.asyncio
async def test_tenure_refresh_updates_history_score_and_feeds_weight(client):
    from talkfile_engine.weight_policy import WeightPolicy

    from app.services.fairness_service import FairnessService

    await _token(client, "tn1_old@test.com")
    await _token(client, "tn1_new@test.com")
    old, new = await _uid("tn1_old@test.com"), await _uid("tn1_new@test.com")
    async with TestSession() as s:
        u = await s.get(User, old)
        u.created_at = datetime.now(UTC) - timedelta(days=730)
        await s.commit()
        await TenureService(s).refresh([old, new])
        await s.commit()
        assert (await s.get(User, old)).history_score == pytest.approx(0.5)
        assert (await s.get(User, new)).history_score == pytest.approx(0.0)

    # 장기 활동 우대 정책: 같은 조건이면 오래된 계정의 가중치가 tenure_coef × 0.5 만큼 높다
    event_id, tier_id, org = await _setup(client, "tn1", capacity=1)
    async with TestSession() as s:
        await FairnessService(s).save_policy(uuid.UUID(event_id), None, WeightPolicy(tenure_coef=80.0).to_dict())
        await s.commit()
    for email in ("tn1_old@test.com", "tn1_new@test.com"):
        assert (await _apply(client, event_id, tier_id, email)).status_code == 201
    await client.post(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw", headers=auth_headers(org))
    pool_id = (await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")).json()["id"]
    from talkfile_engine.weight_policy import compute_weight

    policy = WeightPolicy(tenure_coef=80.0)
    async with TestSession() as s:
        weights = await FairnessService(s).entry_weights(uuid.UUID(pool_id))
        entries = {
            e.user_id: e
            for e in (await s.execute(select(LotteryEntry).where(LotteryEntry.pool_id == uuid.UUID(pool_id)))).scalars().all()
        }
    for uid, tenure in ((old, 0.5), (new, 0.0)):
        e = entries[uid]
        expected = compute_weight(policy, e.invested_ap, e.fan_weight, e.pity_bonus, tenure_score=tenure)
        assert weights[str(uid)] == expected  # 누적 시간 점수 × tenure_coef 가 가중치에 들어갔다
    e_old = entries[old]
    assert weights[str(old)] - compute_weight(policy, e_old.invested_ap, e_old.fan_weight, e_old.pity_bonus, 0.0) == pytest.approx(40.0)
