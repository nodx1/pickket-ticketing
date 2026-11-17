"""현장 단말 연동 (과업 WP6) — 단말 등록부와 입장 차단 목록.

onsite_terminals   키오스크·POS·게이트 스캐너. 단말마다 키 1개(해시만 저장), 이벤트·게이트 고정,
                   허용 등급(입장 권한). 상태·게이트·권한은 주최사가 바꿀 수 있다(변경은 감사 로그).
admission_blocks   특정 티켓의 입장 차단/해제 기록(append-only). 분실·도난·부정 의심 티켓을 실시간으로
                   막고, 그 목록을 Socket.IO 로 단말에 동기화한다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


def _now() -> datetime:
    return datetime.now(UTC)


class TerminalKind:
    KIOSK = "kiosk"
    POS = "pos"
    GATE_SCANNER = "gate_scanner"
    ALL = (KIOSK, POS, GATE_SCANNER)
    LABEL = {KIOSK: "키오스크", POS: "POS", GATE_SCANNER: "게이트 스캐너"}


class OnsiteTerminal(Base):
    __tablename__ = "onsite_terminals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    gate: Mapped[str] = mapped_column(String(40), nullable=False, default="main")
    # 이 단말에서 입장 가능한 등급 id 목록. 비어 있으면 모든 등급.
    allowed_tier_ids: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    key_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")  # active | suspended | revoked
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_onsite_terminal_event", "event_id"),)


class AdmissionBlock(Base):
    __tablename__ = "admission_blocks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    ticket_number: Mapped[str] = mapped_column(String(32), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)  # block | unblock
    reason: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_admission_block_event", "event_id", "ticket_number", "created_at"),)
