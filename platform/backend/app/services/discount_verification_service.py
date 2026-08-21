import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order import Order
from app.models.order import OrderStatus
from app.models.user import User


SUPPORTED_DISCOUNT_TYPES = {
    "국가유공자",
    "장애인",
    "기초수급자",
    "다자녀",
    "경로우대",
    "청년",
    "군인",
    "임산부",
    "문화누리",
}

DISCOUNT_TYPE_ALIASES = {
    "veteran": "국가유공자",
    "disabled": "장애인",
    "low_income": "기초수급자",
    "multi_child": "다자녀",
    "senior": "경로우대",
    "youth": "청년",
    "soldier": "군인",
    "pregnant": "임산부",
    "culture_nuri": "문화누리",
}

DISCOUNT_APPLICABLE_STATUSES = {
    OrderStatus.PENDING,
    OrderStatus.PAYMENT_REQUIRED,
    OrderStatus.AUTHORIZED,
}


class DiscountVerificationService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def canonicalize_discount_type(discount_type: str) -> str:
        normalized = (discount_type or "").strip()
        return DISCOUNT_TYPE_ALIASES.get(normalized.lower(), normalized)

    @classmethod
    def get_configured_rate(cls, discount_policies: dict | None, discount_type: str) -> float | None:
        if not isinstance(discount_policies, dict):
            return None

        canonical_type = cls.canonicalize_discount_type(discount_type)
        candidates = {
            discount_type,
            discount_type.lower(),
            canonical_type,
            canonical_type.lower(),
        }

        for key in candidates:
            if key not in discount_policies:
                continue
            raw_rate = discount_policies[key]
            try:
                numeric_rate = float(raw_rate)
            except (TypeError, ValueError):
                return None
            if numeric_rate <= 0:
                return None
            return numeric_rate * 100 if numeric_rate <= 1 else numeric_rate
        return None

    async def verify_eligibility(self, user_id: uuid.UUID, discount_type: str) -> bool:
        user = (
            await self.session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if not user:
            return False
        if self.canonicalize_discount_type(discount_type) not in SUPPORTED_DISCOUNT_TYPES:
            return False
        return bool(user.is_verified or user.verification_level >= 1 or user.residence_verified)

    async def apply_discount(self, order_id: uuid.UUID, discount_type: str, rate: float) -> Order:
        order = (
            await self.session.execute(select(Order).where(Order.id == order_id))
        ).scalar_one_or_none()
        if not order:
            raise ValueError("Order not found")
        if order.status not in DISCOUNT_APPLICABLE_STATUSES:
            raise ValueError("Discount can only be applied before payment is completed")

        metadata = dict(order.payment_metadata or {})
        existing_discount_type = metadata.get("discount_type")
        existing_discount_rate = metadata.get("discount_rate")
        canonical_type = self.canonicalize_discount_type(discount_type)

        if existing_discount_type:
            if (
                existing_discount_type == canonical_type
                and float(existing_discount_rate or 0) == float(rate)
            ):
                return order
            raise ValueError("A discount has already been applied to this order")

        base_total = float(metadata.get("original_total_amount", order.total_amount))
        if base_total <= 0:
            raise ValueError("Original order total must be greater than 0")

        metadata["original_total_amount"] = base_total
        metadata["discount_type"] = canonical_type
        metadata["discount_rate"] = rate
        order.payment_metadata = metadata
        order.total_amount = max(0.0, round(base_total * (1 - rate / 100), 2))
        await self.session.flush()
        return order
