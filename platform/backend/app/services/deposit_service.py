"""
Deposit Service
================
Manages no-show prevention deposits for free/public events.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.order import Order, OrderStatus, OrderType


class DynamicDepositCalculator:
    """노쇼 이력 기반 보증금 동적 산출.

    Adjusts deposit amount based on user's historical no-show behavior:
    - First-time user: 1.0x (base amount)
    - 1 no-show: 1.5x
    - 2 no-shows: 2.0x
    - 3+ no-shows: 2.5x (cap)

    Formula: multiplier = 1.0 + min(2.0, no_show_rate x 5)
    where no_show_rate = no_show_count / max(1, total_reservations)
    """

    MAX_MULTIPLIER = 2.5
    RATE_COEFFICIENT = 5.0

    @staticmethod
    def compute_deposit(
        base_amount: int,
        no_show_count: int = 0,
        total_reservations: int = 0,
    ) -> dict:
        """Compute dynamic deposit amount.

        Args:
            base_amount: Base deposit amount for the event.
            no_show_count: User's historical no-show count.
            total_reservations: User's total reservation count.

        Returns:
            Dict with 'amount', 'multiplier', and 'no_show_rate'.
        """
        if total_reservations <= 0:
            no_show_rate = 0.0
        else:
            no_show_rate = no_show_count / total_reservations

        multiplier = 1.0 + min(
            DynamicDepositCalculator.MAX_MULTIPLIER - 1.0,
            no_show_rate * DynamicDepositCalculator.RATE_COEFFICIENT,
        )

        amount = round(base_amount * multiplier)

        return {
            "amount": amount,
            "multiplier": round(multiplier, 2),
            "no_show_rate": round(no_show_rate, 4),
            "no_show_count": no_show_count,
            "total_reservations": total_reservations,
        }


class DepositService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create_deposit(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        amount: float,
    ) -> Order:
        """Create a deposit order for a free event with no-show prevention."""
        if amount <= 0:
            raise ValueError("Deposit amount must be positive")

        # Check if user already has a deposit for this event
        existing = await self.session.execute(
            select(Order).where(
                Order.user_id == user_id,
                Order.event_id == event_id,
                Order.order_type == OrderType.DEPOSIT,
                Order.status.in_([OrderStatus.DEPOSIT_HELD, OrderStatus.PENDING]),
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError("User already has a deposit for this event")

        deposit_order = Order(
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            order_type=OrderType.DEPOSIT,
            status=OrderStatus.DEPOSIT_HELD,
            quantity=1,
            unit_price=amount,
            total_amount=amount,
        )
        self.session.add(deposit_order)
        await self.session.flush()
        return deposit_order

    async def refund_deposit(self, order_id: uuid.UUID) -> Order:
        """Refund a deposit after successful check-in."""
        result = await self.session.execute(
            select(Order).where(
                Order.id == order_id,
                Order.order_type == OrderType.DEPOSIT,
            )
        )
        order = result.scalar_one_or_none()
        if not order:
            raise ValueError("Deposit order not found")

        if order.status != OrderStatus.DEPOSIT_HELD:
            raise ValueError(f"Cannot refund deposit with status {order.status.value}")

        order.status = OrderStatus.DEPOSIT_REFUNDED
        await self.session.flush()
        return order

    async def forfeit_deposit(self, order_id: uuid.UUID) -> Order:
        """Forfeit a deposit due to no-show."""
        result = await self.session.execute(
            select(Order).where(
                Order.id == order_id,
                Order.order_type == OrderType.DEPOSIT,
            )
        )
        order = result.scalar_one_or_none()
        if not order:
            raise ValueError("Deposit order not found")

        if order.status != OrderStatus.DEPOSIT_HELD:
            raise ValueError(f"Cannot forfeit deposit with status {order.status.value}")

        order.status = OrderStatus.DEPOSIT_FORFEITED
        await self.session.flush()
        return order
