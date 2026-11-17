"""가중치 추첨 정책 · Merkle 무결성 · 공정성 증명서 서비스 (과업 WP1·WP4).

추첨 한 번의 흐름과 이 서비스가 끼어드는 지점:

    ① 첫 응모(풀 생성)   시드 사전 커밋 ─ lock_pool_policy(): 그 시점 정책을 스냅숏·고정
    ② 응모 마감          commit_entries_tree(): 응모별 가중치를 확정하고 응모 Merkle 루트 저장
                          (추첨과 **별도 트랜잭션** — 루트가 추첨보다 먼저 영속화됨을 시각으로 증명)
    ③ 추첨               추첨은 ②에서 확정한 가중치만 쓴다(entry_weights)
    ④ 추첨 직후          commit_results_tree(): 결과 Merkle 루트 저장
    ⑤ 증명서 발급        issue_certificate(): 커밋·루트·시드·정책 해시를 Ed25519 로 서명

개인정보: 공개 데이터에는 user_id 대신 user_commit(H(pool|user|salt)) 만 나간다.
본인은 get_inclusion_proof() 로 자기 salt 와 증명 경로를 받아 브라우저에서 직접 검증한다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from talkfile_engine.lottery import compute_lottery_weight
from talkfile_engine.merkle import (
    TREE_ALGORITHM,
    MerkleTree,
    canonical_json,
    hash_leaf,
    sha256_hex,
    user_commit,
    verify_proof,
)
from talkfile_engine.weight_policy import PRESETS, WeightPolicy, format_weight

from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.fairness_signing import SIGNATURE_ALGORITHM, public_key_info, sign, verify
from app.core.redis import cache_delete, cache_get_json, cache_set_json
from app.models.event import Event, SeatTier
from app.models.fairness import (
    FairnessCertificate,
    LotteryMerkleLeaf,
    LotteryMerkleRoot,
    LotteryPoolPolicy,
    LotteryWeightPolicyRecord,
    MerkleKind,
)
from app.models.lottery import LotteryEntry, LotteryEntryResult, LotteryPool, LotteryPoolStatus
from app.models.user import User

logger = logging.getLogger(__name__)

CERT_TYPE = "pickket.fairness_certificate"
CERT_VERSION = 1
_POLICY_CACHE_TTL = 300


class FairnessError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 업무 오류."""


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat()


def _policy_cache_key(pool_id: uuid.UUID) -> str:
    return f"fairness:pool_policy:{{{pool_id}}}"


def _event_policy_cache_key(event_id: uuid.UUID) -> str:
    return f"fairness:event_policy:{{{event_id}}}"


class FairnessService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ───────────────────────── 정책 ─────────────────────────

    async def _policy_records(self, event_id: uuid.UUID) -> list[LotteryWeightPolicyRecord]:
        result = await self.session.execute(
            select(LotteryWeightPolicyRecord).where(LotteryWeightPolicyRecord.event_id == event_id)
        )
        return list(result.scalars().all())

    async def resolve_policy(
        self, event_id: uuid.UUID, tier_id: uuid.UUID | None
    ) -> tuple[WeightPolicy, str, LotteryWeightPolicyRecord | None]:
        """등급 전용 → 이벤트 공통 → 기본 정책 순으로 찾는다."""
        records = await self._policy_records(event_id)
        if tier_id is not None:
            for r in records:
                if r.tier_id == tier_id:
                    return WeightPolicy.from_dict(r.policy), "tier", r
        for r in records:
            if r.tier_id is None:
                return WeightPolicy.from_dict(r.policy), "event", r
        return WeightPolicy(), "default", None

    async def save_policy(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID | None,
        policy_data: dict,
        preset: str = "custom",
        actor: str | None = None,
    ) -> LotteryWeightPolicyRecord:
        if preset != "custom" and preset not in PRESETS:
            raise FairnessError(f"알 수 없는 프리셋입니다: {preset}")
        try:
            policy = WeightPolicy.from_dict(policy_data)
        except (TypeError, ValueError) as exc:
            raise FairnessError(f"가중치 설정값이 올바르지 않습니다: {exc}") from exc

        event_exists = await self.session.scalar(select(Event.id).where(Event.id == event_id))
        if not event_exists:
            raise FairnessError("이벤트를 찾을 수 없습니다")
        if tier_id is not None:
            tier_event = await self.session.scalar(select(SeatTier.event_id).where(SeatTier.id == tier_id))
            if tier_event != event_id:
                raise FairnessError("이 이벤트의 등급이 아닙니다")

        records = await self._policy_records(event_id)
        record = next((r for r in records if r.tier_id == tier_id), None)
        old = dict(record.policy) if record else None
        now = datetime.now(UTC)
        if record is None:
            record = LotteryWeightPolicyRecord(
                event_id=event_id,
                tier_id=tier_id,
                preset=preset,
                policy=policy.to_dict(),
                policy_hash=policy.policy_hash(),
                updated_by=actor,
                created_at=now,
                updated_at=now,
            )
            self.session.add(record)
        else:
            record.preset = preset
            record.policy = policy.to_dict()
            record.policy_hash = policy.policy_hash()
            record.updated_by = actor
            record.updated_at = now
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="lottery_weight_policy_saved",
            resource_type="lottery_weight_policy",
            resource_id=str(record.id),
            event_id=event_id,
            tier_id=tier_id,
            old_value=old,
            new_value={"policy": policy.to_dict(), "policy_hash": policy.policy_hash(), "preset": preset, "actor": actor},
        )
        try:
            await cache_delete(_event_policy_cache_key(event_id))
        except Exception:
            logger.debug("policy cache invalidate failed", exc_info=True)
        return record

    async def lock_pool_policy(self, pool: LotteryPool) -> LotteryPoolPolicy | None:
        """풀 사전 커밋 시점에 정책을 스냅숏한다. 이미 있으면 그대로 돌려준다."""
        if not isinstance(pool, LotteryPool):
            return None  # 실제 DB 행만 다룬다(목 객체 등은 무시)
        existing = await self.session.get(LotteryPoolPolicy, pool.id)
        if isinstance(existing, LotteryPoolPolicy):
            return existing
        policy, source, _ = await self.resolve_policy(pool.event_id, pool.tier_id)
        snap = LotteryPoolPolicy(
            pool_id=pool.id,
            policy=policy.to_dict(),
            policy_hash=policy.policy_hash(),
            source=source,
            locked_at=datetime.now(UTC),
        )
        self.session.add(snap)
        await self.session.flush()
        return snap

    async def get_pool_policy(self, pool_id: uuid.UUID) -> tuple[WeightPolicy, bool]:
        """(정책, 스냅숏 존재 여부). 스냅숏이 없는 기존 풀은 기본 정책."""
        cached = None
        try:
            cached = await cache_get_json(_policy_cache_key(pool_id))
        except Exception:  # noqa: BLE001
            cached = None
        if isinstance(cached, dict) and "policy" in cached:
            return WeightPolicy.from_dict(cached["policy"]), True
        snap = await self.session.get(LotteryPoolPolicy, pool_id)
        if not isinstance(snap, LotteryPoolPolicy):
            return WeightPolicy(), False
        try:
            await cache_set_json(_policy_cache_key(pool_id), {"policy": snap.policy}, ttl=_POLICY_CACHE_TTL)
        except Exception:
            logger.debug("policy cache set failed", exc_info=True)
        return WeightPolicy.from_dict(snap.policy), True

    async def event_policy_view(self, event_id: uuid.UUID) -> dict:
        """주최사 설정 화면용: 이벤트 공통·등급별 정책 + 이미 잠긴 풀."""
        records = await self._policy_records(event_id)
        tiers = (
            await self.session.execute(
                select(SeatTier.id, SeatTier.name, SeatTier.sale_mode).where(SeatTier.event_id == event_id)
            )
        ).all()
        pools = (
            await self.session.execute(
                select(LotteryPool.id, LotteryPool.tier_id, LotteryPool.status, LotteryPoolPolicy.policy_hash, LotteryPoolPolicy.locked_at, LotteryPoolPolicy.policy)
                .join(LotteryPoolPolicy, LotteryPoolPolicy.pool_id == LotteryPool.id, isouter=True)
                .where(LotteryPool.event_id == event_id)
            )
        ).all()
        event_record = next((r for r in records if r.tier_id is None), None)
        return {
            "event_id": str(event_id),
            "defaults": WeightPolicy().to_dict(),
            "presets": {name: p.to_dict() for name, p in PRESETS.items()},
            "event_policy": _record_view(event_record),
            "tiers": [
                {
                    "tier_id": str(t.id),
                    "name": t.name,
                    "sale_mode": t.sale_mode,
                    "policy": _record_view(next((r for r in records if r.tier_id == t.id), None)),
                    "locked_pool": next(
                        (
                            {
                                "pool_id": str(p.id),
                                "status": p.status.value if hasattr(p.status, "value") else str(p.status),
                                "policy_hash": p.policy_hash,
                                "locked_at": _iso(p.locked_at),
                                "policy": p.policy,
                            }
                            for p in pools
                            if p.tier_id == t.id
                        ),
                        None,
                    ),
                }
                for t in tiers
            ],
        }

    # ───────────────────────── Merkle ─────────────────────────

    async def get_root(self, pool_id: uuid.UUID, kind: str) -> LotteryMerkleRoot | None:
        root = await self.session.get(LotteryMerkleRoot, {"pool_id": pool_id, "kind": kind})
        return root if isinstance(root, LotteryMerkleRoot) else None

    async def _tenure_scores(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, float]:
        """정상 누적 시간 점수(0~1). `users.history_score` — 일 배치(WP2)가 갱신한다."""
        if not user_ids:
            return {}
        rows = (await self.session.execute(select(User.id, User.history_score).where(User.id.in_(user_ids)))).all()
        return {r.id: float(r.history_score or 0.0) for r in rows}

    async def commit_entries_tree(
        self, pool: LotteryPool, entries: list[LotteryEntry], excluded_user_ids: set[uuid.UUID] | None = None
    ) -> tuple[LotteryMerkleRoot, dict[str, float]]:
        """응모 마감: 응모별 가중치를 확정하고 응모 Merkle 루트를 저장한다(멱등).

        excluded_user_ids: 제재(Slash)로 추첨에서 빠지는 응모. 트리에는 남기되 가중치 0으로 기록해
        "누가 왜 빠졌는지"까지 루트에 묶는다.
        """
        existing = await self.get_root(pool.id, MerkleKind.ENTRIES)
        if existing is not None:
            return existing, await self.entry_weights(pool.id)

        policy, _ = await self.get_pool_policy(pool.id)
        excluded = excluded_user_ids or set()
        tenure = await self._tenure_scores([e.user_id for e in entries]) if policy.tenure_coef else {}

        rows = []
        for e in entries:
            if e.user_id in excluded:
                weight_text = "0"
                status = "excluded"
            else:
                w = compute_lottery_weight(
                    invested_ap=e.invested_ap or 0,
                    fan_weight=e.fan_weight,
                    tier_multiplier=e.tier_multiplier or 1.0,
                    pity_bonus=e.pity_bonus or 1.0,
                    policy=policy,
                    tenure_score=tenure.get(e.user_id, 0.0),
                )
                weight_text = format_weight(w)
                status = "eligible"
            salt = secrets.token_hex(16)
            payload = {
                "v": 1,
                "kind": "entry",
                "pool": str(pool.id),
                "user_commit": user_commit(str(pool.id), str(e.user_id), salt),
                "weight": weight_text,
                "ap": int(e.invested_ap or 0),
                "group_size": int(e.group_size or 1),
                "client_seed_hash": sha256_hex(e.client_seed) if e.client_seed else "",
                "status": status,
            }
            rows.append((hash_leaf(payload), e, salt, payload))

        rows.sort(key=lambda r: r[0])
        tree = MerkleTree([r[0] for r in rows])
        for idx, (leaf_hash, e, salt, payload) in enumerate(rows):
            self.session.add(
                LotteryMerkleLeaf(
                    pool_id=pool.id,
                    kind=MerkleKind.ENTRIES,
                    idx=idx,
                    leaf_hash=leaf_hash,
                    entry_id=e.id,
                    user_id=e.user_id,
                    salt=salt,
                    payload=payload,
                )
            )
        root = LotteryMerkleRoot(
            pool_id=pool.id,
            kind=MerkleKind.ENTRIES,
            root=tree.root,
            leaf_count=len(tree),
            tree_algorithm=TREE_ALGORITHM,
            built_at=datetime.now(UTC),
        )
        self.session.add(root)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="lottery_entries_root_commit",
            resource_type="lottery",
            resource_id=str(pool.id),
            event_id=pool.event_id,
            tier_id=pool.tier_id,
            new_value={
                "pool_id": str(pool.id),
                "entries_root": tree.root,
                "leaf_count": len(tree),
                "excluded": len(excluded & {e.user_id for e in entries}),
                "policy_hash": policy.policy_hash(),
                "algorithm": policy.algorithm,
            },
        )
        weights = {str(e.user_id): float(p["weight"]) for _, e, _, p in rows}
        return root, weights

    async def entry_weights(self, pool_id: uuid.UUID) -> dict[str, float]:
        rows = (
            await self.session.execute(
                select(LotteryMerkleLeaf.user_id, LotteryMerkleLeaf.payload).where(
                    LotteryMerkleLeaf.pool_id == pool_id, LotteryMerkleLeaf.kind == MerkleKind.ENTRIES
                )
            )
        ).all()
        return {str(r.user_id): float(r.payload["weight"]) for r in rows if isinstance(r.payload, dict)}

    async def excluded_users(self, pool_id: uuid.UUID) -> set[str]:
        rows = (
            await self.session.execute(
                select(LotteryMerkleLeaf.user_id, LotteryMerkleLeaf.payload).where(
                    LotteryMerkleLeaf.pool_id == pool_id, LotteryMerkleLeaf.kind == MerkleKind.ENTRIES
                )
            )
        ).all()
        return {
            str(r.user_id) for r in rows if isinstance(r.payload, dict) and r.payload.get("status") == "excluded"
        }

    async def commit_results_tree(
        self, pool: LotteryPool, outcomes: dict[str, dict]
    ) -> LotteryMerkleRoot | None:
        """추첨 직후: 결과 Merkle 루트 저장. outcomes[user_id] = {result, order, ap_charged, path}.

        결과 잎 순서는 응모 트리와 같다(같은 idx) — 본인 증명 시 두 트리를 같은 위치로 찾는다.
        응모 트리가 없는 기존 풀은 건너뛴다(None).
        """
        if await self.get_root(pool.id, MerkleKind.RESULTS) is not None:
            return await self.get_root(pool.id, MerkleKind.RESULTS)
        entry_leaves = (
            await self.session.execute(
                select(LotteryMerkleLeaf)
                .where(LotteryMerkleLeaf.pool_id == pool.id, LotteryMerkleLeaf.kind == MerkleKind.ENTRIES)
                .order_by(LotteryMerkleLeaf.idx)
            )
        ).scalars().all()
        if not entry_leaves:
            return None
        hashes: list[str] = []
        for leaf in entry_leaves:
            o = outcomes.get(str(leaf.user_id), {})
            payload = {
                "v": 1,
                "kind": "result",
                "pool": str(pool.id),
                "entry_leaf": leaf.leaf_hash,
                "result": o.get("result", "waitlisted"),
                "order": o.get("order"),
                "ap_charged": int(o.get("ap_charged", 0)),
                "path": o.get("path", "draw"),
            }
            h = hash_leaf(payload)
            hashes.append(h)
            self.session.add(
                LotteryMerkleLeaf(
                    pool_id=pool.id,
                    kind=MerkleKind.RESULTS,
                    idx=leaf.idx,
                    leaf_hash=h,
                    entry_id=leaf.entry_id,
                    user_id=leaf.user_id,
                    salt=None,
                    payload=payload,
                )
            )
        tree = MerkleTree(hashes)
        root = LotteryMerkleRoot(
            pool_id=pool.id,
            kind=MerkleKind.RESULTS,
            root=tree.root,
            leaf_count=len(tree),
            tree_algorithm=TREE_ALGORITHM,
            built_at=datetime.now(UTC),
        )
        self.session.add(root)
        await self.session.flush()
        return root

    async def get_inclusion_proof(self, pool_id: uuid.UUID, user_id: uuid.UUID) -> dict:
        """본인 응모의 포함 증명. 응모·결과 트리 각각의 잎·경로·루트를 준다."""
        mine = (
            await self.session.execute(
                select(LotteryMerkleLeaf).where(
                    LotteryMerkleLeaf.pool_id == pool_id, LotteryMerkleLeaf.user_id == user_id
                )
            )
        ).scalars().all()
        by_kind = {leaf.kind: leaf for leaf in mine}
        if MerkleKind.ENTRIES not in by_kind:
            raise FairnessError("이 추첨에서 내 응모 기록을 찾을 수 없습니다")
        out: dict = {"pool_id": str(pool_id), "user_id": str(user_id), "tree_algorithm": TREE_ALGORITHM}
        for kind in (MerkleKind.ENTRIES, MerkleKind.RESULTS):
            leaf = by_kind.get(kind)
            root = await self.get_root(pool_id, kind)
            if leaf is None or root is None:
                out[kind] = None
                continue
            hashes = (
                await self.session.execute(
                    select(LotteryMerkleLeaf.leaf_hash)
                    .where(LotteryMerkleLeaf.pool_id == pool_id, LotteryMerkleLeaf.kind == kind)
                    .order_by(LotteryMerkleLeaf.idx)
                )
            ).scalars().all()
            tree = MerkleTree(list(hashes))
            proof = [s.to_dict() for s in tree.proof(leaf.idx)]
            out[kind] = {
                "index": leaf.idx,
                "leaf_hash": leaf.leaf_hash,
                "payload": leaf.payload,
                "proof": proof,
                "root": root.root,
                "verified": verify_proof(leaf.leaf_hash, proof, root.root) and tree.root == root.root,
            }
        out["salt"] = by_kind[MerkleKind.ENTRIES].salt
        return out

    async def pool_roots(self, pool_id: uuid.UUID) -> dict:
        roots = (
            await self.session.execute(select(LotteryMerkleRoot).where(LotteryMerkleRoot.pool_id == pool_id))
        ).scalars().all()
        return {
            r.kind: {"root": r.root, "leaf_count": r.leaf_count, "built_at": _iso(r.built_at), "tree_algorithm": r.tree_algorithm}
            for r in roots
        }

    async def public_leaves(self, pool_id: uuid.UUID, kind: str) -> list[dict]:
        """공개 잎 목록(user_id·salt 제외). 누구나 루트를 직접 다시 계산할 수 있다."""
        rows = (
            await self.session.execute(
                select(LotteryMerkleLeaf.idx, LotteryMerkleLeaf.leaf_hash, LotteryMerkleLeaf.payload)
                .where(LotteryMerkleLeaf.pool_id == pool_id, LotteryMerkleLeaf.kind == kind)
                .order_by(LotteryMerkleLeaf.idx)
            )
        ).all()
        return [{"index": r.idx, "leaf_hash": r.leaf_hash, "payload": r.payload} for r in rows]

    # ───────────────────────── 증명서 ─────────────────────────

    async def _next_cert_no(self, year: int) -> str:
        if self.session.get_bind().dialect.name == "sqlite":  # 테스트 DB — 시퀀스 없음
            seq = int(await self.session.scalar(select(func.count()).select_from(FairnessCertificate)) or 0) + 1
        else:
            seq = await self.session.scalar(text("SELECT nextval('fairness_certificate_seq')"))
        return f"PKT-FC-{year}-{int(seq):06d}"

    async def issue_certificate(self, pool_id: uuid.UUID, issued_by: str | None = None) -> FairnessCertificate:
        existing = await self.session.scalar(
            select(FairnessCertificate).where(FairnessCertificate.pool_id == pool_id)
        )
        if existing is not None:
            return existing

        pool = await self.session.get(LotteryPool, pool_id)
        if pool is None:
            raise FairnessError("추첨 풀을 찾을 수 없습니다")
        if pool.status != LotteryPoolStatus.DRAWN:
            raise FairnessError("추첨이 끝난 뒤에 증명서를 발급할 수 있습니다")
        entries_root = await self.get_root(pool_id, MerkleKind.ENTRIES)
        results_root = await self.get_root(pool_id, MerkleKind.RESULTS)
        if entries_root is None or results_root is None:
            raise FairnessError("Merkle 기록 이전에 추첨된 풀이라 증명서를 발급할 수 없습니다")

        policy, _ = await self.get_pool_policy(pool_id)
        snap = await self.session.get(LotteryPoolPolicy, pool_id)
        event = await self.session.get(Event, pool.event_id)
        tier = await self.session.get(SeatTier, pool.tier_id)
        counts_rows = (
            await self.session.execute(
                select(LotteryEntry.result, func.count()).where(LotteryEntry.pool_id == pool_id).group_by(LotteryEntry.result)
            )
        ).all()
        counts = {(r[0].value if hasattr(r[0], "value") else str(r[0])): int(r[1]) for r in counts_rows}
        excluded = await self.excluded_users(pool_id)
        vd = pool.verification_data or {}
        now = datetime.now(UTC)
        cert_no = await self._next_cert_no(now.year)

        payload = {
            "type": CERT_TYPE,
            "v": CERT_VERSION,
            "cert_no": cert_no,
            "issuer": "Pickket",
            "event": {"id": str(pool.event_id), "title": event.title if event else ""},
            "tier": {"id": str(pool.tier_id), "name": tier.name if tier else ""},
            "pool_id": str(pool_id),
            "algorithm": vd.get("algorithm") or "efraimidis_spirakis_weighted_sampling",
            "policy": policy.to_dict(),
            "policy_hash": policy.policy_hash(),
            "policy_locked_at": _iso(snap.locked_at) if snap else None,
            "seed_commitment": pool.seed_commitment,
            "committed_at": _iso(pool.committed_at),
            "entries_root": entries_root.root,
            "entries_root_at": _iso(entries_root.built_at),
            "drawn_at": _iso(pool.drawn_at),
            "server_seed": str(pool.server_seed) if pool.server_seed is not None else None,
            "seed_used": str(pool.seed_used) if pool.seed_used is not None else None,
            "results_root": results_root.root,
            "result_hash": vd.get("result_hash"),
            "tree_algorithm": TREE_ALGORITHM,
            "counts": {
                "applicants": entries_root.leaf_count,
                "winners": counts.get(LotteryEntryResult.WON.value, 0),
                "waitlisted": counts.get(LotteryEntryResult.WAITLISTED.value, 0),
                "excluded_by_sanction": len(excluded),
                "capacity": int(pool.total_seats or 0),
            },
            "issued_at": _iso(now),
            "verify_url": f"{settings.FAIRNESS_PUBLIC_BASE_URL.rstrip('/')}/fairness/certificates/{cert_no}",
        }
        message = canonical_json(payload)
        signature, key_id = sign(message)
        cert = FairnessCertificate(
            cert_no=cert_no,
            pool_id=pool_id,
            event_id=pool.event_id,
            payload=payload,
            payload_hash=hashlib.sha256(message).hexdigest(),
            signature=signature,
            key_id=key_id,
            signature_algorithm=SIGNATURE_ALGORITHM,
            issued_by=issued_by,
            issued_at=now,
        )
        self.session.add(cert)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="fairness_certificate_issued",
            resource_type="fairness_certificate",
            resource_id=cert_no,
            event_id=pool.event_id,
            tier_id=pool.tier_id,
            new_value={"cert_no": cert_no, "pool_id": str(pool_id), "payload_hash": cert.payload_hash, "key_id": key_id, "issued_by": issued_by},
        )
        return cert

    async def certificate_view(self, cert_no: str) -> dict:
        cert = await self.session.scalar(select(FairnessCertificate).where(FairnessCertificate.cert_no == cert_no))
        if cert is None:
            raise FairnessError("증명서를 찾을 수 없습니다")
        return await self._certificate_view(cert)

    async def _certificate_view(self, cert: FairnessCertificate) -> dict:
        message = canonical_json(cert.payload)
        key = public_key_info()
        signature_valid = key["key_id"] == cert.key_id and verify(message, cert.signature, key["public_key"])
        # 저장된 루트와 지금 DB 의 루트가 같은지(사후 변조 탐지)
        roots = await self.pool_roots(cert.pool_id)
        live = {
            "payload_hash_matches": hashlib.sha256(message).hexdigest() == cert.payload_hash,
            "signature_valid": signature_valid,
            "entries_root_matches": roots.get(MerkleKind.ENTRIES, {}).get("root") == cert.payload.get("entries_root"),
            "results_root_matches": roots.get(MerkleKind.RESULTS, {}).get("root") == cert.payload.get("results_root"),
            "entries_root_before_draw": bool(
                cert.payload.get("entries_root_at")
                and cert.payload.get("drawn_at")
                and cert.payload["entries_root_at"] < cert.payload["drawn_at"]
            ),
            "commit_before_draw": bool(
                cert.payload.get("committed_at")
                and cert.payload.get("drawn_at")
                and cert.payload["committed_at"] < cert.payload["drawn_at"]
            ),
        }
        live["all_valid"] = all(live.values())
        return {
            "cert_no": cert.cert_no,
            "payload": cert.payload,
            "canonical_payload": message.decode("utf-8"),
            "payload_hash": cert.payload_hash,
            "signature": cert.signature,
            "signature_algorithm": cert.signature_algorithm,
            "key_id": cert.key_id,
            "public_key": key["public_key"] if key["key_id"] == cert.key_id else None,
            "issued_at": _iso(cert.issued_at),
            "checks": live,
        }

    async def event_fairness_overview(self, event_id: uuid.UUID) -> dict:
        """주최사 화면: 이벤트의 추첨 풀별 진행 단계·루트·증명서."""
        pools = (
            await self.session.execute(select(LotteryPool).where(LotteryPool.event_id == event_id))
        ).scalars().all()
        tiers = {
            t.id: t.name
            for t in (await self.session.execute(select(SeatTier).where(SeatTier.event_id == event_id))).scalars().all()
        }
        out = []
        for p in pools:
            roots = await self.pool_roots(p.id)
            snap = await self.session.get(LotteryPoolPolicy, p.id)
            cert = await self.session.scalar(select(FairnessCertificate).where(FairnessCertificate.pool_id == p.id))
            applicants = await self.session.scalar(select(func.count()).where(LotteryEntry.pool_id == p.id))
            vd = p.verification_data or {}
            out.append(
                {
                    "pool_id": str(p.id),
                    "tier_id": str(p.tier_id),
                    "tier_name": tiers.get(p.tier_id, ""),
                    "status": p.status.value if hasattr(p.status, "value") else str(p.status),
                    "applicants": int(applicants or 0),
                    "capacity": int(p.total_seats or 0),
                    "algorithm": vd.get("algorithm") or (snap.policy.get("algorithm") if snap else "weighted_lottery"),
                    "policy_hash": snap.policy_hash if snap else None,
                    "timeline": {
                        "policy_locked_at": _iso(snap.locked_at) if snap else None,
                        "seed_committed_at": _iso(p.committed_at),
                        "entries_root_at": roots.get(MerkleKind.ENTRIES, {}).get("built_at"),
                        "drawn_at": _iso(p.drawn_at),
                        "results_root_at": roots.get(MerkleKind.RESULTS, {}).get("built_at"),
                        "certificate_issued_at": _iso(cert.issued_at) if cert else None,
                    },
                    "seed_commitment": p.seed_commitment,
                    "entries_root": roots.get(MerkleKind.ENTRIES, {}).get("root"),
                    "results_root": roots.get(MerkleKind.RESULTS, {}).get("root"),
                    "certificate": {"cert_no": cert.cert_no, "issued_at": _iso(cert.issued_at)} if cert else None,
                }
            )
        return {"event_id": str(event_id), "pools": out}

    async def masked_results(self, pool_id: uuid.UUID) -> list[dict]:
        """주최사 결과 화면·CSV: 이름·연락처 가림."""
        rows = (
            await self.session.execute(
                select(LotteryEntry, User.name, User.phone)
                .join(User, User.id == LotteryEntry.user_id)
                .where(LotteryEntry.pool_id == pool_id)
                .order_by(LotteryEntry.result, LotteryEntry.created_at)
            )
        ).all()
        excluded = await self.excluded_users(pool_id)
        weights = await self.entry_weights(pool_id)
        out = []
        for entry, user_name, phone in rows:
            uid = str(entry.user_id)
            out.append(
                {
                    "entry_id": str(entry.id),
                    "name": _mask_name(user_name),
                    "phone": _mask_phone(phone),
                    "result": "excluded" if uid in excluded else (entry.result.value if hasattr(entry.result, "value") else str(entry.result)),
                    "invested_ap": int(entry.invested_ap or 0),
                    "weight": weights.get(uid),
                    "group_size": int(entry.group_size or 1),
                    "applied_at": _iso(entry.created_at),
                }
            )
        return out


def _record_view(record: LotteryWeightPolicyRecord | None) -> dict | None:
    if record is None:
        return None
    return {
        "id": str(record.id),
        "preset": record.preset,
        "policy": record.policy,
        "policy_hash": record.policy_hash,
        "updated_by": record.updated_by,
        "updated_at": _iso(record.updated_at),
    }


def _mask_name(name: str | None) -> str:
    if not name:
        return "-"
    if len(name) <= 1:
        return "*"
    if len(name) == 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def _mask_phone(phone: str | None) -> str:
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if len(digits) < 8:
        return "-"
    return f"{digits[:3]}-****-{digits[-4:]}"


def certificate_to_json(view: dict) -> str:
    return json.dumps(view, ensure_ascii=False, sort_keys=True)
