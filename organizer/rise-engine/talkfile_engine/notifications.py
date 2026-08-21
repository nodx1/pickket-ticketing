"""
RISE Notification System
=========================
Event-driven notification service for ticket operations.

Notification types:
  - Bid/purchase confirmations
  - Allocation results (win/lose)
  - Waitlist updates
  - Dutch price drop alerts
  - Payment reminders
  - Cancellation offers (waitlist → winner)
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class NotificationType(Enum):
    BID_CONFIRMED = "bid_confirmed"
    ALLOCATION_RESULT = "allocation_result"
    WAITLIST_UPDATE = "waitlist_update"
    DUTCH_PRICE_DROP = "dutch_price_drop"
    DUTCH_TARGET_REACHED = "dutch_target_reached"
    PAYMENT_REMINDER = "payment_reminder"
    CANCELLATION_OFFER = "cancellation_offer"
    LOTTERY_RESULT = "lottery_result"
    SEAT_ASSIGNED = "seat_assigned"


@dataclass
class Notification:
    """A single notification to be sent to a user."""
    type: NotificationType
    user_id: str
    event_id: str
    tier_id: str
    message: str
    data: dict = field(default_factory=dict)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sent: bool = False


@dataclass
class PriceAlert:
    """User-registered Dutch auction price alert."""
    user_id: str
    event_id: str
    tier_id: str
    target_price: float


class NotificationService:
    """Manages notifications and price alerts."""

    def __init__(self):
        self._notifications: list[Notification] = []
        self._price_alerts: list[PriceAlert] = []

    def notify(self, notification: Notification) -> None:
        """Queue a notification for delivery."""
        self._notifications.append(notification)

    def get_pending(self, user_id: str | None = None) -> list[Notification]:
        """Get unsent notifications, optionally filtered by user."""
        results = [n for n in self._notifications if not n.sent]
        if user_id:
            results = [n for n in results if n.user_id == user_id]
        return results

    def mark_sent(self, user_id: str | None = None) -> int:
        """Mark notifications as sent. Returns count marked."""
        count = 0
        for n in self._notifications:
            if not n.sent:
                if user_id is None or n.user_id == user_id:
                    n.sent = True
                    count += 1
        return count

    def get_all(self, event_id: str | None = None) -> list[Notification]:
        """Get all notifications, optionally filtered by event."""
        if event_id:
            return [n for n in self._notifications if n.event_id == event_id]
        return list(self._notifications)

    def register_price_alert(self, alert: PriceAlert) -> None:
        """Register a Dutch price alert for a user."""
        self._price_alerts.append(alert)

    def check_dutch_alerts(
        self,
        event_id: str,
        tier_id: str,
        current_price: float,
    ) -> list[Notification]:
        """
        Check if any price alerts should fire at the current Dutch price.
        Returns notifications to send.
        """
        triggered: list[Notification] = []
        remaining: list[PriceAlert] = []

        for alert in self._price_alerts:
            if alert.event_id == event_id and alert.tier_id == tier_id:
                if current_price <= alert.target_price:
                    notif = Notification(
                        type=NotificationType.DUTCH_TARGET_REACHED,
                        user_id=alert.user_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        message=f"Price dropped to {current_price:,.0f} (your target: {alert.target_price:,.0f})",
                        data={"current_price": current_price, "target_price": alert.target_price},
                    )
                    triggered.append(notif)
                    self._notifications.append(notif)
                else:
                    remaining.append(alert)
            else:
                remaining.append(alert)

        self._price_alerts = remaining
        return triggered

    def notify_allocation_result(
        self,
        event_id: str,
        tier_id: str,
        user_id: str,
        won: bool,
        price: float = 0.0,
        waitlist_position: int | None = None,
        explanation: str = "",
    ) -> Notification:
        """Create and queue an allocation result notification."""
        if won:
            message = f"Congratulations! You won a seat at {price:,.0f}"
        elif waitlist_position:
            message = f"You are #{waitlist_position} on the waitlist. {explanation}"
        else:
            message = f"Unfortunately you were not selected. {explanation}"

        notif = Notification(
            type=NotificationType.ALLOCATION_RESULT,
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            message=message,
            data={
                "won": won,
                "price": price,
                "waitlist_position": waitlist_position,
                "explanation": explanation,
            },
        )
        self._notifications.append(notif)
        return notif

    def notify_cancellation_offer(
        self,
        event_id: str,
        tier_id: str,
        user_id: str,
        price: float,
        deadline_minutes: int = 30,
    ) -> Notification:
        """Notify waitlisted user of a cancellation opportunity."""
        notif = Notification(
            type=NotificationType.CANCELLATION_OFFER,
            user_id=user_id,
            event_id=event_id,
            tier_id=tier_id,
            message=f"A seat is available at {price:,.0f}! You have {deadline_minutes} minutes to pay.",
            data={"price": price, "deadline_minutes": deadline_minutes},
        )
        self._notifications.append(notif)
        return notif
