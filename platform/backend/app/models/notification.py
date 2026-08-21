import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Boolean, ForeignKey, DateTime, Text, JSON, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class NotificationModel(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("idx_notification_user_read", "user_id", "is_read"),
        # P0-11: hotpath composite index
        Index("idx_notification_user_read_created", "user_id", "is_read", "created_at"),
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("ix_notifications_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 상세통합 S1(§7.3): 게스트 통지 사각 해소. 게스트 통지는 user_id 없이 guest_id 로 발행되므로
    # user_id 를 nullable 화(가산·비파괴 — 기존 회원 통지 무영향). 정확히-하나 강제는 CHECK 없이
    # 애플리케이션 계층(게스트 통지 발행 경로)에서 보장(S2/S3 연동).
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # 게스트 수신자(§7.3). SET NULL — 게스트 삭제(PII 청소) 시 통지 이력 보존.
    guest_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("guests.id", ondelete="SET NULL"), nullable=True, index=True
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="SET NULL"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    is_sent: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class PriceAlertModel(Base):
    __tablename__ = "price_alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=False
    )
    target_price: Mapped[float] = mapped_column(Money, nullable=False)
    triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
