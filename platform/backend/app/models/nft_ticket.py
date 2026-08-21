import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class NftStatus(str, PyEnum):
    """NFT 발행 라이프사이클 (MASTER N7 — 기존 String, dead default 'pending' 정정)."""
    PENDING = "pending"
    METADATA_READY = "metadata_ready"
    MINTING = "minting"
    MINTED = "minted"
    FAILED = "failed"


class NftTicket(Base):
    __tablename__ = "nft_tickets"
    __table_args__ = (
        Index("idx_nft_tickets_event_status", "event_id", "status"),
        Index("idx_nft_tickets_owner", "owner_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    token_name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(String(1000), nullable=False)
    image_url: Mapped[str] = mapped_column(String(500), nullable=False)
    attributes: Mapped[list[dict] | None] = mapped_column(_JSON_TYPE, nullable=True)
    chain: Mapped[str | None] = mapped_column(String(50), nullable=True)
    contract_address: Mapped[str | None] = mapped_column(String(200), nullable=True)
    token_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tx_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    minted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(
        String(30), default=NftStatus.METADATA_READY.value, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
