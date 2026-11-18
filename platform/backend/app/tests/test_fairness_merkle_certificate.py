"""과업 WP1·WP3·WP4 — 가중치 정책 · 가중 배분 · Merkle 무결성 · 공정성 증명서 (DB 통합).

흐름: 응모 → (정책 스냅숏) → 추첨 요청 → [별도 트랜잭션] 응모 루트 확정 → 추첨 → 결과 루트 → 증명서
"""

import base64
import uuid

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select
from talkfile_engine.lottery import compute_lottery_weight
from talkfile_engine.merkle import canonical_json, hash_leaf, user_commit, verify_proof
from talkfile_engine.weight_policy import WeightPolicy

from app.models.fairness import LotteryMerkleLeaf, LotteryMerkleRoot, LotteryPoolPolicy, MerkleKind
from app.models.lottery import LotteryEntry, LotteryPool
from app.models.point import PointTransactionType, PointType
from app.models.user import User
from app.services.fairness_service import FairnessError, FairnessService
from app.services.point_service import PointService
from app.tests.conftest import TestSession, auth_headers, create_event_as_organizer, get_auth_token


async def _grant_ap(email: str, amount: int) -> uuid.UUID:
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


async def _balance(user_id: uuid.UUID) -> int:
    async with TestSession() as session:
        return await PointService(session).get_balance(user_id, PointType.FAN)


async def _event_with_tier(client, prefix: str, capacity: int):
    org_token = await get_auth_token(client, email=f"org_{prefix}@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "R석", "capacity": capacity, "base_price": 100.0, "sale_mode": "point_lottery", "face_price": 100.0},
        headers=auth_headers(org_token),
    )
    assert tier.status_code in (200, 201), tier.text
    return event["id"], tier.json()["id"], org_token


async def _save_policy(event_id: str, policy: WeightPolicy, tier_id: str | None = None):
    async with TestSession() as session:
        await FairnessService(session).save_policy(
            uuid.UUID(event_id), uuid.UUID(tier_id) if tier_id else None, policy.to_dict(), actor="test"
        )
        await session.commit()


async def _apply(client, event_id, tier_id, email, *, ap=0, group_size=1):
    token = await get_auth_token(client, email=email)
    if ap:
        await _grant_ap(email, ap)
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/apply",
        json={"group_size": group_size, "invested_ap": ap},
        headers=auth_headers(token),
    )
    return token, resp


async def _pool_id(client, event_id, tier_id) -> str:
    return (await client.get(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/status")).json()["id"]


async def _draw(client, event_id, tier_id, org_token):
    resp = await client.post(f"/api/v1/events/{event_id}/tiers/{tier_id}/lottery/draw", headers=auth_headers(org_token))
    assert resp.status_code == 200, resp.text
    return resp.json()


# ───────────────────────── Merkle ─────────────────────────


@pytest.mark.asyncio
async def test_entries_root_precedes_draw_and_every_applicant_can_prove_inclusion(client):
    event_id, tier_id, org = await _event_with_tier(client, "mk1", capacity=3)
    tokens = []
    for i in range(7):
        token, resp = await _apply(client, event_id, tier_id, f"mk1_b{i}@test.com")
        assert resp.status_code == 201, resp.text
        tokens.append(token)
    pool_id = await _pool_id(client, event_id, tier_id)
    await _draw(client, event_id, tier_id, org)

    roots = (await client.get(f"/api/v1/fairness/pools/{pool_id}/roots")).json()["roots"]
    assert set(roots) == {"entries", "results"}
    assert roots["entries"]["leaf_count"] == 7

    async with TestSession() as s:
        pool = await s.get(LotteryPool, uuid.UUID(pool_id))
        entries_root = await s.get(LotteryMerkleRoot, {"pool_id": pool.id, "kind": MerkleKind.ENTRIES})
        # 응모 루트는 추첨보다 먼저 기록된다(별도 트랜잭션)
        assert entries_root.built_at.replace(tzinfo=None) <= pool.drawn_at.replace(tzinfo=None)

    won = 0
    for token in tokens:
        proof = (await client.get(f"/api/v1/fairness/pools/{pool_id}/my-proof", headers=auth_headers(token))).json()
        entry = proof["entries"]
        assert entry["verified"] is True
        # 브라우저가 하는 일과 같은 계산: salt 로 user_commit 재계산 → 잎 해시 → 경로 → 루트
        assert entry["payload"]["user_commit"] == user_commit(pool_id, proof["user_id"], proof["salt"])
        assert hash_leaf(entry["payload"]) == entry["leaf_hash"]
        assert verify_proof(entry["leaf_hash"], entry["proof"], roots["entries"]["root"])
        result = proof["results"]
        assert verify_proof(result["leaf_hash"], result["proof"], roots["results"]["root"])
        assert result["payload"]["entry_leaf"] == entry["leaf_hash"]
        won += result["payload"]["result"] == "won"
    assert won == 3


@pytest.mark.asyncio
async def test_public_leaves_hide_identity_and_rebuild_root(client):
    event_id, tier_id, org = await _event_with_tier(client, "mk2", capacity=2)
    for i in range(5):
        await _apply(client, event_id, tier_id, f"mk2_b{i}@test.com")
    pool_id = await _pool_id(client, event_id, tier_id)
    await _draw(client, event_id, tier_id, org)

    data = (await client.get(f"/api/v1/fairness/pools/{pool_id}/leaves?kind=entries")).json()
    raw = canonical_json({"leaves": data["leaves"]}).decode()
    async with TestSession() as s:
        user_ids = [str(u) for u in (await s.execute(select(LotteryEntry.user_id))).scalars().all()]
    assert not any(uid in raw for uid in user_ids)  # 공개 잎에 user_id 없음
    assert "salt" not in raw

    from talkfile_engine.merkle import MerkleTree

    rebuilt = MerkleTree([hash_leaf(leaf["payload"]) for leaf in data["leaves"]]).root
    roots = (await client.get(f"/api/v1/fairness/pools/{pool_id}/roots")).json()["roots"]
    assert rebuilt == roots["entries"]["root"]


@pytest.mark.asyncio
async def test_default_policy_weights_equal_legacy_formula(client):
    event_id, tier_id, org = await _event_with_tier(client, "mk3", capacity=2)
    for i, ap in enumerate([0, 300, 1000, 2500]):
        _, resp = await _apply(client, event_id, tier_id, f"mk3_b{i}@test.com", ap=ap)
        assert resp.status_code == 201, resp.text
    pool_id = await _pool_id(client, event_id, tier_id)
    await _draw(client, event_id, tier_id, org)

    async with TestSession() as s:
        entries = (await s.execute(select(LotteryEntry).where(LotteryEntry.pool_id == uuid.UUID(pool_id)))).scalars().all()
        weights = await FairnessService(s).entry_weights(uuid.UUID(pool_id))
    for e in entries:
        legacy = compute_lottery_weight(e.invested_ap, e.fan_weight, e.tier_multiplier, e.pity_bonus)
        assert weights[str(e.user_id)] == legacy  # 비트 단위 동일 — 기존 추첨 결과 불변


# ───────────────────────── 정책 ─────────────────────────


@pytest.mark.asyncio
async def test_policy_is_locked_at_pool_creation(client):
    event_id, tier_id, org = await _event_with_tier(client, "pl1", capacity=2)
    first = WeightPolicy(fan_coef=120.0)
    await _save_policy(event_id, first)
    await _apply(client, event_id, tier_id, "pl1_b0@test.com")
    pool_id = await _pool_id(client, event_id, tier_id)

    # 풀이 생긴 뒤 정책을 바꿔도 이 풀은 처음 정책을 유지한다
    await _save_policy(event_id, WeightPolicy(fan_coef=10.0))
    async with TestSession() as s:
        snap = await s.get(LotteryPoolPolicy, uuid.UUID(pool_id))
        assert snap.policy_hash == first.policy_hash()
        assert snap.source == "event"
        view = await FairnessService(s).event_policy_view(uuid.UUID(event_id))
    tier_view = next(t for t in view["tiers"] if t["tier_id"] == tier_id)
    assert tier_view["locked_pool"]["policy_hash"] == first.policy_hash()


@pytest.mark.asyncio
async def test_invalid_policy_rejected(client):
    event_id, _, _ = await _event_with_tier(client, "pl2", capacity=2)
    async with TestSession() as s:
        with pytest.raises(FairnessError):
            await FairnessService(s).save_policy(uuid.UUID(event_id), None, {"fan_coef": -5})
        with pytest.raises(FairnessError):
            await FairnessService(s).save_policy(uuid.UUID(event_id), None, {"algorithm": "auction"})


# ───────────────────────── 가중 배분 (가중 VCG) ─────────────────────────


@pytest.mark.asyncio
async def test_weighted_allocation_draw_charges_vcg_price_and_verifies(client):
    event_id, tier_id, org = await _event_with_tier(client, "va1", capacity=2)
    await _save_policy(event_id, WeightPolicy(algorithm="weighted_allocation", ap_scale=0.0, fan_coef=0.0, pity_coef=0.0))
    bids = {"va1_b0@test.com": 2000, "va1_b1@test.com": 1500, "va1_b2@test.com": 1000, "va1_b3@test.com": 500}
    users = {}
    for email, ap in bids.items():
        _, resp = await _apply(client, event_id, tier_id, email, ap=ap)
        assert resp.status_code == 201, resp.text
        async with TestSession() as s:
            users[email] = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
    before = {email: await _balance(uid) for email, uid in users.items()}
    pool_id = await _pool_id(client, event_id, tier_id)
    await _draw(client, event_id, tier_id, org)

    # 가중치가 같으므로 가중 가치 = 투입 AP. 상위 2명 당첨, 가격 = 3등 가치(1000)
    after = {email: await _balance(uid) for email, uid in users.items()}
    assert after["va1_b0@test.com"] - before["va1_b0@test.com"] == 2000 - 1000  # 차액 환급
    assert after["va1_b1@test.com"] - before["va1_b1@test.com"] == 1500 - 1000
    assert after["va1_b2@test.com"] - before["va1_b2@test.com"] == 1000  # 낙첨 전액 환급
    assert after["va1_b3@test.com"] - before["va1_b3@test.com"] == 500

    verify = (await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")).json()
    assert verify["is_valid"] is True, verify["checks"]
    assert verify["algorithm"] == "weighted_allocation_v1"
    assert verify["checks"]["charges_match"] is True
    assert verify["checks"]["commit_precedes_draw"] is True
    # 대외 표기 규칙: 공개 응답에 금지어 없음
    assert "vcg" not in verify["algorithm"].lower()


@pytest.mark.asyncio
async def test_weighted_allocation_rejects_group_entry(client):
    event_id, tier_id, _ = await _event_with_tier(client, "va2", capacity=4)
    await _save_policy(event_id, WeightPolicy(algorithm="weighted_allocation"))
    _, ok = await _apply(client, event_id, tier_id, "va2_b0@test.com")
    assert ok.status_code == 201
    _, resp = await _apply(client, event_id, tier_id, "va2_b1@test.com", group_size=2)
    assert resp.status_code in (400, 409, 422)


# ───────────────────────── 증명서 ─────────────────────────


@pytest.mark.asyncio
async def test_certificate_signature_and_live_checks(client):
    event_id, tier_id, org = await _event_with_tier(client, "fc1", capacity=2)
    for i in range(5):
        await _apply(client, event_id, tier_id, f"fc1_b{i}@test.com")
    pool_id = await _pool_id(client, event_id, tier_id)

    async with TestSession() as s:
        with pytest.raises(FairnessError):  # 추첨 전에는 발급 불가
            await FairnessService(s).issue_certificate(uuid.UUID(pool_id))

    await _draw(client, event_id, tier_id, org)
    async with TestSession() as s:
        cert = await FairnessService(s).issue_certificate(uuid.UUID(pool_id), issued_by="org")
        again = await FairnessService(s).issue_certificate(uuid.UUID(pool_id))
        assert again.cert_no == cert.cert_no  # 멱등
        cert_no = cert.cert_no
        await s.commit()
    assert cert_no.startswith("PKT-FC-")

    view = (await client.get(f"/api/v1/fairness/certificates/{cert_no}")).json()
    assert view["checks"]["all_valid"] is True, view["checks"]
    p = view["payload"]
    assert p["counts"]["applicants"] == 5 and p["counts"]["winners"] == 2
    assert p["entries_root_at"] <= p["drawn_at"] and p["committed_at"] < p["drawn_at"]

    # 제3자 검증: 공개키로 canonical payload 서명 확인
    key = (await client.get("/api/v1/fairness/keys")).json()
    Ed25519PublicKey.from_public_bytes(base64.b64decode(key["public_key"])).verify(
        base64.b64decode(view["signature"]), canonical_json(p)
    )
    assert view["canonical_payload"] == canonical_json(p).decode()

    pdf = await client.get(f"/api/v1/fairness/certificates/{cert_no}/pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.content[:4] == b"%PDF"

    listing = (await client.get(f"/api/v1/fairness/events/{event_id}/certificates")).json()
    assert [c["cert_no"] for c in listing["certificates"]] == [cert_no]


@pytest.mark.asyncio
async def test_tampering_after_issue_is_detected(client):
    """SQLite(트리거 없음)에서 루트·잎을 직접 바꿔 본다 — 운영 PG 는 트리거가 아예 막는다."""
    event_id, tier_id, org = await _event_with_tier(client, "fc2", capacity=1)
    tokens = []
    for i in range(3):
        token, _ = await _apply(client, event_id, tier_id, f"fc2_b{i}@test.com")
        tokens.append(token)
    pool_id = await _pool_id(client, event_id, tier_id)
    await _draw(client, event_id, tier_id, org)
    async with TestSession() as s:
        cert = await FairnessService(s).issue_certificate(uuid.UUID(pool_id))
        cert_no = cert.cert_no
        await s.commit()

    async with TestSession() as s:
        leaf = (
            await s.execute(
                select(LotteryMerkleLeaf).where(
                    LotteryMerkleLeaf.pool_id == uuid.UUID(pool_id), LotteryMerkleLeaf.kind == MerkleKind.ENTRIES
                )
            )
        ).scalars().first()
        leaf.payload = {**leaf.payload, "weight": "9999"}  # 가중치 조작
        root = await s.get(LotteryMerkleRoot, {"pool_id": uuid.UUID(pool_id), "kind": MerkleKind.RESULTS})
        root.root = "0" * 64  # 결과 루트 조작
        await s.commit()

    view = (await client.get(f"/api/v1/fairness/certificates/{cert_no}")).json()
    assert view["checks"]["results_root_matches"] is False
    assert view["checks"]["all_valid"] is False
    # 조작된 잎은 더 이상 루트로 이어지지 않는다
    for token in tokens:
        proof = (await client.get(f"/api/v1/fairness/pools/{pool_id}/my-proof", headers=auth_headers(token))).json()
        if hash_leaf(proof["entries"]["payload"]) != proof["entries"]["leaf_hash"]:
            break
    else:
        pytest.fail("tampered leaf not detected")


# ───────────────────────── 주최사 「지금 추첨하기」 (피켓고 → v2 internal) ─────────────────────────


def _go_signed(body: bytes = b"{}") -> dict:
    import time

    from app.core.config import settings
    from app.core.webhook_verifier import compute_signature

    ts = str(int(time.time()))
    return {
        "content-type": "application/json",
        "x-pickket-timestamp": ts,
        "x-pickket-signature": compute_signature(settings.GO_WEBHOOK_SECRET, ts, body),
        "x-pickket-event": "gwasup.lottery.draw",
        "x-pickket-delivery-id": str(uuid.uuid4()),
    }


@pytest.mark.asyncio
async def test_draw_now_only_after_deadline_and_only_once(client, monkeypatch):
    """마감 전 거부 → 마감 뒤 추첨 → 다시 눌러도 다시 뽑지 않는다(자동 추첨과 겹쳐도 한 번)."""
    from datetime import datetime, timedelta, timezone

    from app.core.config import settings
    from app.models.phase_config import PhaseConfig

    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", "test_go_secret_draw_now")

    # 서명·재사용 검사는 webhook_verifier 테스트가 맡는다(테스트용 FakeRedis 는 재사용 검사를 못 함).
    async def _skip_verify(*_a, **_k):
        return None

    monkeypatch.setattr("app.api.v1.fairness.verify_pickket_webhook", _skip_verify)
    event_id, tier_id, _org = await _event_with_tier(client, "dn1", capacity=2)
    for i in range(4):
        _, resp = await _apply(client, event_id, tier_id, f"dn1_b{i}@test.com")
        assert resp.status_code == 201, resp.text
    pool_id = await _pool_id(client, event_id, tier_id)

    now = datetime.now(timezone.utc)
    async with TestSession() as session:
        session.add(PhaseConfig(event_id=uuid.UUID(event_id), phase="lottery", starts_at=now - timedelta(hours=2),
                                ends_at=now + timedelta(hours=1), sort_order=0, status="open", config={}))
        await session.commit()
    early = await client.post(f"/api/v1/internal/lottery/pools/{pool_id}/draw", content=b"{}", headers=_go_signed())
    assert early.status_code == 400, early.text

    async with TestSession() as session:
        pc = (await session.execute(select(PhaseConfig).where(PhaseConfig.event_id == uuid.UUID(event_id)))).scalar_one()
        pc.ends_at = now - timedelta(minutes=1)
        await session.commit()
    first = await client.post(f"/api/v1/internal/lottery/pools/{pool_id}/draw", content=b"{}", headers=_go_signed())
    assert first.status_code == 200, first.text
    assert first.json()["winners"] == 2 and first.json()["already_drawn"] is False
    again = await client.post(f"/api/v1/internal/lottery/pools/{pool_id}/draw", content=b"{}", headers=_go_signed())
    assert again.status_code == 200 and again.json()["already_drawn"] is True

    overview = await client.get(f"/api/v1/internal/events/{event_id}/fairness", headers={"x-pickket-service-token": settings.GO_WEBHOOK_SECRET})
    pool = overview.json()["pools"][0]
    assert pool["status"] == "drawn" and pool["can_draw"] is False and pool["closes_at"]


@pytest.mark.asyncio
async def test_go_policy_save_and_certificate_issue_are_committed(client, monkeypatch):
    """🔴 피켓고 → v2 내부 쓰기(가중치 정책 저장·증명서 발급)는 응답 뒤에도 DB 에 남아야 한다.

    get_db 는 자동 커밋하지 않아, 커밋이 빠지면 응답은 200 인데 새 세션에서는 아무것도 안 보였다
    (실측 2026-11-18: 주최사가 고른 정책이 추첨에 반영되지 않고 발급한 증명서가 공개 목록에 없음).
    """
    from datetime import datetime, timedelta, timezone

    from app.core.config import settings
    from app.models.fairness import FairnessCertificate, LotteryWeightPolicyRecord
    from app.models.phase_config import PhaseConfig

    async def _skip_verify(*_a, **_k):
        return None

    monkeypatch.setattr("app.api.v1.fairness.verify_pickket_webhook", _skip_verify)
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", "test_go_secret_commit")
    event_id, tier_id, _org = await _event_with_tier(client, "cm1", capacity=2)

    policy = {**WeightPolicy().to_dict(), "tenure_coef": 30.0}
    put = await client.put(
        f"/api/v1/internal/events/{event_id}/lottery-policy",
        content=json_bytes({"tierId": tier_id, "policy": policy, "preset": "custom", "actor": "go:test"}),
        headers=_go_signed(),
    )
    assert put.status_code == 200, put.text
    async with TestSession() as session:
        saved = (
            await session.execute(
                select(LotteryWeightPolicyRecord).where(LotteryWeightPolicyRecord.event_id == uuid.UUID(event_id))
            )
        ).scalars().all()
        assert saved, "정책 저장이 커밋되지 않았다"

    for i in range(3):
        _, resp = await _apply(client, event_id, tier_id, f"cm1_b{i}@test.com")
        assert resp.status_code == 201, resp.text
    pool_id = await _pool_id(client, event_id, tier_id)
    now = datetime.now(timezone.utc)
    async with TestSession() as session:
        session.add(PhaseConfig(event_id=uuid.UUID(event_id), phase="lottery", starts_at=now - timedelta(hours=2),
                                ends_at=now - timedelta(minutes=1), sort_order=0, status="open", config={}))
        await session.commit()
    drew = await client.post(f"/api/v1/internal/lottery/pools/{pool_id}/draw", content=b"{}", headers=_go_signed())
    assert drew.status_code == 200, drew.text

    issued = await client.post(f"/api/v1/internal/lottery/pools/{pool_id}/certificate", content=b"{}", headers=_go_signed())
    assert issued.status_code == 200, issued.text
    cert_no = issued.json()["cert_no"]
    async with TestSession() as session:
        row = await session.scalar(select(FairnessCertificate).where(FairnessCertificate.cert_no == cert_no))
        assert row is not None, "증명서 발급이 커밋되지 않았다"
    public = await client.get(f"/api/v1/fairness/events/{event_id}/certificates")
    assert [c["cert_no"] for c in public.json()["certificates"]] == [cert_no]


def json_bytes(obj) -> bytes:
    import json

    return json.dumps(obj).encode()


@pytest.mark.asyncio
async def test_go_lottery_stats_reports_actual_draw_time(client, monkeypatch):
    """🔴 피켓고 「응모 현황」의 추첨일은 실제 추첨 시각(drawn_at)이어야 한다.

    예전엔 풀 생성 시각(첫 응모 시각)을 보내 마감 전에 추첨한 것처럼 보였다(실측 2026-11-18).
    """
    from app.core.config import settings

    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", "test_go_secret_stats")
    # 이 통계 엔드포인트는 get_db 대신 async_session 을 직접 연다 — 테스트 DB 로 돌린다.
    monkeypatch.setattr("app.api.v1.internal_sync.async_session", TestSession)
    event_id, tier_id, org = await _event_with_tier(client, "ds1", capacity=1)
    for i in range(2):
        _, resp = await _apply(client, event_id, tier_id, f"ds1_b{i}@test.com")
        assert resp.status_code == 201, resp.text
    pool_id = await _pool_id(client, event_id, tier_id)
    async with TestSession() as session:
        pool = await session.get(LotteryPool, uuid.UUID(pool_id))
        pool.created_at = pool.created_at.replace(year=2020)  # 생성 시각과 추첨 시각을 확실히 벌린다
        await session.commit()
    await _draw(client, event_id, tier_id, org)

    stats = await client.get(
        f"/api/v1/internal/events/{event_id}/lottery-stats", headers={"x-pickket-service-token": settings.internal_service_token}
    )
    assert stats.status_code == 200, stats.text
    async with TestSession() as session:
        drawn_at = (await session.get(LotteryPool, uuid.UUID(pool_id))).drawn_at
    body = stats.json()
    data = body.get("data", body)
    assert data["drawExecutedAt"] is not None and not data["drawExecutedAt"].startswith("2020")
    assert data["drawExecutedAt"][:19] == drawn_at.isoformat()[:19]
