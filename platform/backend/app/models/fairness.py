"""가중치 추첨 정책 · Merkle 무결성 · 공정성 증명서 데이터 모델.

과업: "가중치 추첨 데이터 설계", "Merkle 트리 기반으로 추첨 결과의 무결성을 보장하는 데이터 모델",
"Merkle 트리 기반 공정성 증명서 발행·조회".

- lottery_weight_policies : 주최사가 이벤트(또는 등급)별로 설정하는 가중치 정책. 수정 가능(감사 로그 기록).
- lottery_pool_policies   : 추첨 풀 사전 커밋 시점의 정책 스냅숏. append-only — 커밋 후 정책은 바뀌지 않는다.
- lottery_merkle_leaves   : 응모/결과 트리의 잎. append-only. salt·user_id 는 비공개(본인 증명에만 사용).
- lottery_merkle_roots    : 응모/결과 트리 루트. append-only.
- fairness_certificates   : Ed25519 서명된 공정성 증명서. append-only.

append-only 는 DB 트리거(UPDATE/DELETE/TRUNCATE 거부)로 강제한다 — 마이그레이션 fairness_1117.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


def _now() -> datetime:
    return datetime.now(UTC)


class MerkleKind:
    ENTRIES = "entries"
    RESULTS = "results"


class LotteryWeightPolicyRecord(Base):
    __tablename__ = "lottery_weight_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # NULL = 이벤트 공통 정책. 값이 있으면 그 등급 전용(공통보다 우선).
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=True
    )
    preset: Mapped[str] = mapped_column(String(32), nullable=False, default="custom")
    policy: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)
    policy_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_lwp_event", "event_id"),)


class LotteryPoolPolicy(Base):
    __tablename__ = "lottery_pool_policies"

    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lottery_pools.id", ondelete="RESTRICT"), primary_key=True
    )
    policy: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)
    policy_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # event | tier | default — 어느 정책을 스냅숏했는지
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    locked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class LotteryMerkleLeaf(Base):
    __tablename__ = "lottery_merkle_leaves"

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), primary_key=True, autoincrement=True)
    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lottery_pools.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    leaf_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # 🔒 비공개 — 본인 포함 증명 API 에서 본인에게만 내준다
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    salt: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)

    __table_args__ = (
        UniqueConstraint("pool_id", "kind", "idx", name="uq_merkle_leaf_pos"),
        Index("idx_merkle_leaf_pool_user", "pool_id", "user_id"),
    )


class LotteryMerkleRoot(Base):
    __tablename__ = "lottery_merkle_roots"

    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lottery_pools.id", ondelete="RESTRICT"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    root: Mapped[str] = mapped_column(String(64), nullable=False)
    leaf_count: Mapped[int] = mapped_column(Integer, nullable=False)
    tree_algorithm: Mapped[str] = mapped_column(String(64), nullable=False)
    built_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class FairnessCertificate(Base):
    __tablename__ = "fairness_certificates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    cert_no: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    pool_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("lottery_pools.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    payload: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    signature: Mapped[str] = mapped_column(String(128), nullable=False)
    key_id: Mapped[str] = mapped_column(String(32), nullable=False)
    signature_algorithm: Mapped[str] = mapped_column(String(16), nullable=False, default="Ed25519")
    issued_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_fairness_cert_event", "event_id"),)
