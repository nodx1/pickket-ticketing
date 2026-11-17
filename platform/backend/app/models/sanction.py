"""계정 제재(Slash) 원장 — 과업 WP2 "위반 계정 적발 시 권한을 소각(Slash)".

append-only: 제재 부과·해제·검토 표시는 모두 새 행이다. 현재 상태는 마지막 행으로 판정한다.
    action = impose  → AP 소각 + 응모 자격 박탈(disqualify_until 까지) + 진행 중 응모 추첨 제외
    action = flag    → 처벌 없이 검토 대상으로 표시(예: 같은 기기 다중 계정 의심)
    action = lift    → 해제(관련 제재 id 를 related_id 로)

event_id 가 있으면 그 이벤트에만, 없으면 플랫폼 전체에 적용된다(주최사는 이벤트 범위만 가능).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class SanctionAction:
    IMPOSE = "impose"
    FLAG = "flag"
    LIFT = "lift"


class SanctionReason:
    MACRO_BOT = "macro_bot"  # 매크로·봇 행동 점수 초과
    MULTI_ACCOUNT = "multi_account"  # 계정 복제(같은 기기·본인인증 중복)
    TICKET_FRAUD = "ticket_fraud"  # 입장권 부정 사용(캡처 공유·중복 입장 시도)
    SCALPING = "scalping"  # 되팔이 패턴
    MANUAL = "manual"  # 운영자 판단

    ALL = (MACRO_BOT, MULTI_ACCOUNT, TICKET_FRAUD, SCALPING, MANUAL)
    LABEL = {
        MACRO_BOT: "매크로·봇 의심",
        MULTI_ACCOUNT: "다중 계정(계정 복제)",
        TICKET_FRAUD: "입장권 부정 사용",
        SCALPING: "되팔이 의심",
        MANUAL: "운영자 판단",
    }


class AccountSanction(Base):
    __tablename__ = "account_sanctions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    reason_code: Mapped[str] = mapped_column(String(32), nullable=False)
    evidence: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False, default=dict)
    ap_burned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    disqualify_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    related_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    __table_args__ = (
        Index("idx_sanction_user_time", "user_id", "created_at"),
        Index("idx_sanction_event_time", "event_id", "created_at"),
    )
