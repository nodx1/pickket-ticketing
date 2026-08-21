"""Event Open Subscription — 티켓오픈 알림 구독 (P6)

Laylo DNA 흡수: 1-click opt-in으로 팬이 "티켓오픈 알림 받기" 등록,
이벤트 오픈 D-30min / D-5min / LIVE 3단계 푸시/SMS/알림톡 발사.

정책 근거: docs/plans/12_MASTER_DICE_LAYLO_ABSORPTION.md §A2
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    String,
    DateTime,
    ForeignKey,
    Index,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventOpenSubscription(Base):
    __tablename__ = "event_open_subscriptions"
    __table_args__ = (
        # 로그인 유저: 이벤트당 1건
        UniqueConstraint("event_id", "user_id", name="uq_eos_event_user"),
        # 비로그인 유저: 전화번호당 1건
        UniqueConstraint("event_id", "phone", name="uq_eos_event_phone"),
        Index("idx_eos_event_id", "event_id"),
        Index("idx_eos_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    phone: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # E.164 format
    channel: Mapped[str] = mapped_column(
        String(20), nullable=False, default="push"
    )  # push | sms | alimtalk
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )  # deprecated — phase별 컬럼 사용
    notified_d30_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    notified_d5_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    notified_live_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
