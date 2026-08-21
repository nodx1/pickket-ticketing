"""Point wallet and transaction models for dual point system.

Users earn Fan Points (entertainment events) and Social Points (public/sports events).
Points serve as lottery weights in the point-weighted lottery system.
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class PointType(str, enum.Enum):
    FAN = "fan"
    SOCIAL = "social"


class PointTransactionType(str, enum.Enum):
    EARN_SIGNUP = "earn_signup"
    EARN_MONTHLY = "earn_monthly"
    EARN_CHECKIN = "earn_checkin"
    EARN_ATTENDANCE = "earn_attendance"
    EARN_REVIEW = "earn_review"
    EARN_FANCLUB = "earn_fanclub"
    EARN_CONSOLATION = "earn_consolation"
    EARN_RESIDENCY = "earn_residency"
    EARN_SOCIAL_QUALIFICATION = "earn_social_qualification"
    # WP07: 구매 기반 AP (추첨 가중치에서 제외)
    EARN_PURCHASE = "earn_purchase"  # 티켓 구매 시 지급
    EARN_GOODS = "earn_goods"  # 굿즈 구매 시 지급
    # WP07: 활동 기반 AP (추첨 가중치에 포함)
    EARN_INVITE = "earn_invite"  # 친구 초대
    EARN_SHARE = "earn_share"  # SNS 공유
    EARN_QUEST = "earn_quest"  # 퀘스트 완료
    EARN_MILESTONE = "earn_milestone"  # 마일스톤 달성
    EARN_STREAK = "earn_streak"  # 출석 스트릭
    EARN_GENRE_SUPPORTER = "earn_genre_supporter"  # 장르 서포터 달성
    # WP07: 추첨 관련
    INVEST_LOTTERY = "invest_lottery"  # AP 투자 (추첨)
    REFUND_LOTTERY = "refund_lottery"  # 낙첨 환급
    EARN_CONSOLATION_LOTTERY = "earn_consolation_lottery"  # 낙첨 위로금
    # WP09: AP Shop
    DEDUCT_SHOP = "deduct_shop"  # AP Shop 교환
    REFUND_SHOP = "refund_shop"  # AP Shop 교환 취소 환급
    # WP22: 도메인별 특화 AP
    EARN_DOMAIN_SPECIAL = "earn_domain_special"
    DEDUCT_NOSHOW = "deduct_noshow"
    DEDUCT_FRAUD = "deduct_fraud"
    ADMIN_ADJUST = "admin_adjust"


point_type_enum = Enum(
    PointType,
    name="point_type_enum",
    values_callable=lambda enum_type: [member.value for member in enum_type],
    create_constraint=False,
)

point_tx_type_enum = Enum(
    PointTransactionType,
    name="point_tx_type_enum",
    values_callable=lambda enum_type: [member.value for member in enum_type],
    create_constraint=False,
)


class PointWallet(Base):
    __tablename__ = "point_wallets"
    __table_args__ = (
        UniqueConstraint("user_id", "point_type", name="uq_point_wallets_user_type"),
        CheckConstraint("balance >= 0", name="ck_point_wallets_balance_nonneg"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    point_type: Mapped[PointType] = mapped_column(
        point_type_enum,
        nullable=False,
    )
    balance: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    lifetime_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    lifetime_spent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    transactions: Mapped[list["PointTransaction"]] = relationship(back_populates="wallet", lazy="raise")


class PointTransaction(Base):
    __tablename__ = "point_transactions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    wallet_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("point_wallets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    tx_type: Mapped[PointTransactionType] = mapped_column(
        point_tx_type_enum,
        nullable=False,
    )
    amount: Mapped[int] = mapped_column(Integer, nullable=False)  # positive=earn, negative=deduct
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    reference_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )  # event_id, etc.
    description: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 멱등키 — 재시도 중복 적립/차감 차단 (MASTER N6). nullable, unique.
    idempotency_key: Mapped[str | None] = mapped_column(
        String(150), nullable=True, unique=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    wallet: Mapped["PointWallet"] = relationship(back_populates="transactions", lazy="raise")
