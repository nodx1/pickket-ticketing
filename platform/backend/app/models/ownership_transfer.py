import uuid
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, Index, Integer, String, ForeignKey, Enum, DateTime, Boolean
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money


class TransferType(str, PyEnum):
    PRIMARY_SALE = "primary_sale"
    RESALE = "resale"
    GIFT = "gift"
    CANCELLATION_REFUND = "cancellation_refund"
    # 상세통합 S2b(§2.4): 게스트 → 회원 승격(claim) 시 소유권 이전 원장.
    # from_user_id=NULL(게스트는 users FK 없음), to_user_id=claim 한 회원. metadata 에 guest_id.
    GUEST_CLAIM = "guest_claim"


class TransferStatus(str, PyEnum):
    """양도 라이프사이클 (MASTER N7 — 기존 String+CHECK, dead default 'completed' 정정)."""
    PENDING = "pending"
    INITIATED = "initiated"
    IDENTITY_VERIFIED = "identity_verified"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class OwnershipTransfer(Base):
    __tablename__ = "ownership_transfers"
    __table_args__ = (
        Index("idx_transfer_ticket", "ticket_id"),
        Index("idx_transfer_from_user", "from_user_id"),
        Index("idx_transfer_to_user", "to_user_id"),
        Index("idx_transfer_status", "status"),
        CheckConstraint(
            "status IN ('pending', 'initiated', 'identity_verified', 'completed', 'cancelled')",
            name="ck_ownership_transfers_status",
        ),
        CheckConstraint(
            "from_user_id <> to_user_id",
            name="ck_ownership_transfers_no_self_loop",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=False
    )
    from_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    to_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    transfer_type: Mapped[TransferType] = mapped_column(Enum(TransferType, values_callable=lambda e: [x.value for x in e]), nullable=False)
    price: Mapped[Decimal] = mapped_column(Money, default=0.0)
    seller_amount: Mapped[Decimal] = mapped_column(Money, default=0.0)
    platform_fee: Mapped[Decimal] = mapped_column(Money, default=0.0)
    artist_royalty: Mapped[Decimal] = mapped_column(Money, default=0.0)
    # default=completed: PRIMARY_SALE(구매 즉시완료 양도)이 default 사용. 양도 프로세스
    # (transfer_service)는 'initiated' 명시 override. (dead default 아님 — purchase 의존)
    status: Mapped[str] = mapped_column(String(30), default=TransferStatus.COMPLETED.value)
    initiated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    buyer_phone_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    transfer_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # §26 P0: Transfer code expiry and brute-force protection
    code_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verify_attempts: Mapped[int] = mapped_column(Integer, default=0)
    transferred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    ticket: Mapped["Ticket"] = relationship(back_populates="transfers", lazy="raise")  # noqa: F821
