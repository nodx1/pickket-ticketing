"""패키지 상품(Package Product) 모델.

여러 이벤트를 묶어 하나의 패키지로 판매하는 상품 모델.
PackageProduct: 패키지 메타 정보 (이름, 카테고리, 상태 등).
PackageItem: 패키지에 포함된 개별 이벤트 항목 (좌석 등급, 정가, 할인가).
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, DateTime, ForeignKey, Enum, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money


class PackageStatus(str, PyEnum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    ON_SALE = "on_sale"
    CLOSED = "closed"


class PackageProduct(Base):
    __tablename__ = "package_products"
    __table_args__ = (
        Index("idx_package_products_organizer_id", "organizer_id"),
        Index("idx_package_products_status", "status"),
        Index("idx_package_products_category", "category"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    sub_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    desired_open_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[PackageStatus] = mapped_column(
        Enum(PackageStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=PackageStatus.DRAFT, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    items: Mapped[list["PackageItem"]] = relationship(
        back_populates="package", cascade="all, delete-orphan", lazy="raise"
    )


class PackageItem(Base):
    __tablename__ = "package_items"
    __table_args__ = (
        Index("idx_package_items_package_id", "package_id"),
        Index("idx_package_items_event_id", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    package_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("package_products.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    seat_tier: Mapped[str | None] = mapped_column(String(100), nullable=True)
    regular_price: Mapped[float] = mapped_column(Money, nullable=False)
    discount_price: Mapped[float] = mapped_column(Money, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    package: Mapped["PackageProduct"] = relationship(back_populates="items", lazy="raise")
