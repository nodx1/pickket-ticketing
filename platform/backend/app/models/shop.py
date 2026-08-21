"""AP Shop models — 아이템 및 교환 기록.

WP09: AP Shop 교환 한도 시스템.
카테고리별 월간 AP 사용 한도와 이상 패턴 감지를 지원합니다.
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ShopCategory(str, enum.Enum):
    DIGITAL = "digital"  # 디지털 굿즈
    LIMITED_BADGE = "limited_badge"  # 한정판 뱃지
    OFFLINE = "offline"  # 오프라인 특전
    PREMIUM = "premium"  # 프리미엄 기능


class ShopExchangeStatus(str, enum.Enum):
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    SHIPPED = "shipped"


# 카테고리별 월간 AP 사용 한도 (None = 무제한)
MONTHLY_LIMITS: dict[ShopCategory, int | None] = {
    ShopCategory.DIGITAL: 3000,
    ShopCategory.LIMITED_BADGE: 2000,
    ShopCategory.OFFLINE: None,
    ShopCategory.PREMIUM: None,
}


shop_category_enum = Enum(
    ShopCategory,
    name="shop_category_enum",
    values_callable=lambda enum_type: [m.value for m in enum_type],
    create_constraint=False,
)

shop_exchange_status_enum = Enum(
    ShopExchangeStatus,
    name="shop_exchange_status_enum",
    values_callable=lambda enum_type: [m.value for m in enum_type],
    create_constraint=False,
)


class ShopItem(Base):
    """AP Shop 상품."""

    __tablename__ = "shop_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[ShopCategory] = mapped_column(shop_category_enum, nullable=False)
    ap_price: Mapped[int] = mapped_column(Integer, nullable=False)
    stock: Mapped[int | None] = mapped_column(Integer, nullable=True)  # None = 무제한
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    organizer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )  # 주최자 커스텀 리워드
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class ShopExchange(Base):
    """AP Shop 교환 기록."""

    __tablename__ = "shop_exchanges"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shop_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ap_spent: Mapped[int] = mapped_column(Integer, nullable=False)
    category: Mapped[ShopCategory] = mapped_column(shop_category_enum, nullable=False)
    status: Mapped[ShopExchangeStatus] = mapped_column(
        shop_exchange_status_enum,
        nullable=False,
        default=ShopExchangeStatus.COMPLETED,
    )
    shipping_address: Mapped[str | None] = mapped_column(Text, nullable=True)  # 실물 상품만

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
