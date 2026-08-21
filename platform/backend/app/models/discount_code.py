"""할인코드(DiscountCode) 모델.

이벤트별 프로모션 할인코드를 관리한다.
주최자가 코드를 생성하고, 소비자가 구매 시 코드를 입력해 할인 혜택을 받는다.
퍼센트 할인 / 정액 할인 두 가지 유형을 지원한다.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    CheckConstraint,
    String,
    Boolean,
    DateTime,
    Float,
    Integer,
    ForeignKey,
    Enum,
    Text,
    Index,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class DiscountCodeType(str, PyEnum):
    PERCENTAGE = "percentage"
    FIXED = "fixed"


class DiscountCode(Base):
    __tablename__ = "discount_codes"
    __table_args__ = (
        Index("idx_discount_codes_event_active", "event_id", "is_active"),
        Index("idx_discount_codes_code", "code"),
        UniqueConstraint("event_id", "code", name="uq_discount_codes_event_code"),
        CheckConstraint("rate IS NULL OR (rate >= 0 AND rate <= 100)", name="ck_discount_codes_rate_range"),
        CheckConstraint("used_count >= 0", name="ck_discount_codes_used_count_nonneg"),
        CheckConstraint(
            "max_uses IS NULL OR used_count <= max_uses",
            name="ck_discount_codes_used_count_le_max",
        ),
        CheckConstraint(
            "valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from",
            name="ck_discount_codes_valid_window",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # 코드 문자열 (예: EARLY20, VIP50)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    # 할인 유형
    discount_type: Mapped[DiscountCodeType] = mapped_column(
        Enum(DiscountCodeType, values_callable=lambda e: [x.value for x in e]), nullable=False
    )
    # 할인율 (percentage일 때 0~100)
    rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 할인 금액 (fixed일 때)
    amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    # 최대 사용 횟수 (null = 무제한)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 현재 사용 횟수
    used_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 유효 기간
    valid_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    valid_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 적용 가능한 티어 ID 목록 (JSON string, null = 전체 티어)
    applicable_tiers: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 최소 주문 금액
    min_order_amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    # 최대 할인 금액 (percentage일 때 캡)
    max_discount_amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    # 설명
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 활성 상태
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # ── 레벨2 W5-COMMERCE: go `promo_codes` 흡수(프로모코드 정본이 여기 하나로) ──
    # 주최자가 코드를 "삭제"해도 행을 지우지 않는다. 이미 그 코드로 만들어진 주문의 사용량
    # 리포트(used_count)가 통째로 사라지기 때문이다. 대신 소프트 삭제로 목록에서 감추고
    # 동시에 `is_active=False` 를 함께 세팅해 **주문 경로에서도 즉시 거부**되게 한다
    # (주문 생성은 is_active 만 보므로, deleted_at 만 세팅하면 삭제한 코드가 계속 먹는다).
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
