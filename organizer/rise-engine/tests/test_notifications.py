"""
Notification System Tests
==========================
Tests for the RISE notification service: queuing, delivery tracking,
Dutch price alerts, allocation results, and cancellation offers.
"""

import pytest
from talkfile_engine.notifications import (
    NotificationType,
    Notification,
    PriceAlert,
    NotificationService,
)


@pytest.fixture
def svc():
    """Fresh NotificationService for each test."""
    return NotificationService()


def _make_notif(user_id="u1", event_id="e1", tier_id="t1", **kwargs):
    """Helper to create a Notification with defaults."""
    return Notification(
        type=kwargs.pop("type", NotificationType.BID_CONFIRMED),
        user_id=user_id,
        event_id=event_id,
        tier_id=tier_id,
        message=kwargs.pop("message", "test notification"),
        **kwargs,
    )


class TestNotifyAndPending:
    """Tests for notify(), get_pending(), and mark_sent()."""

    def test_notify_queues_notification(self, svc):
        """notify() adds a notification to the internal queue."""
        notif = _make_notif()
        svc.notify(notif)
        assert len(svc.get_all()) == 1
        assert svc.get_all()[0] is notif

    def test_get_pending_filters_unsent_only(self, svc):
        """get_pending() returns only notifications where sent=False."""
        n1 = _make_notif(user_id="u1")
        n2 = _make_notif(user_id="u2")
        svc.notify(n1)
        svc.notify(n2)
        # Mark u1's notification as sent directly
        n1.sent = True

        pending = svc.get_pending()
        assert len(pending) == 1
        assert pending[0].user_id == "u2"

    def test_get_pending_filters_by_user(self, svc):
        """get_pending(user_id=...) scopes to that user."""
        svc.notify(_make_notif(user_id="u1"))
        svc.notify(_make_notif(user_id="u2"))

        pending = svc.get_pending(user_id="u1")
        assert len(pending) == 1
        assert pending[0].user_id == "u1"

    def test_mark_sent_marks_notifications(self, svc):
        """mark_sent() sets sent=True and returns count."""
        svc.notify(_make_notif(user_id="u1"))
        svc.notify(_make_notif(user_id="u2"))
        svc.notify(_make_notif(user_id="u1"))

        count = svc.mark_sent(user_id="u1")
        assert count == 2
        # u1 notifications are now sent, u2 still pending
        assert len(svc.get_pending(user_id="u1")) == 0
        assert len(svc.get_pending(user_id="u2")) == 1

    def test_mark_sent_all_when_no_user_filter(self, svc):
        """mark_sent() with no user_id marks everything."""
        svc.notify(_make_notif(user_id="u1"))
        svc.notify(_make_notif(user_id="u2"))

        count = svc.mark_sent()
        assert count == 2
        assert len(svc.get_pending()) == 0


class TestDutchPriceAlerts:
    """Tests for register_price_alert() and check_dutch_alerts()."""

    def test_alert_triggers_when_price_drops_below_target(self, svc):
        """Alert fires when current_price <= target_price."""
        alert = PriceAlert(user_id="u1", event_id="e1", tier_id="t1", target_price=50_000)
        svc.register_price_alert(alert)

        triggered = svc.check_dutch_alerts("e1", "t1", current_price=45_000)
        assert len(triggered) == 1
        assert triggered[0].type == NotificationType.DUTCH_TARGET_REACHED
        assert triggered[0].user_id == "u1"
        assert triggered[0].data["current_price"] == 45_000
        assert triggered[0].data["target_price"] == 50_000

    def test_alert_not_triggered_when_price_above_target(self, svc):
        """Alert does not fire when current_price > target_price."""
        alert = PriceAlert(user_id="u1", event_id="e1", tier_id="t1", target_price=50_000)
        svc.register_price_alert(alert)

        triggered = svc.check_dutch_alerts("e1", "t1", current_price=55_000)
        assert len(triggered) == 0

    def test_triggered_alerts_are_removed(self, svc):
        """Once an alert fires it is removed from the active list."""
        alert = PriceAlert(user_id="u1", event_id="e1", tier_id="t1", target_price=50_000)
        svc.register_price_alert(alert)

        svc.check_dutch_alerts("e1", "t1", current_price=45_000)
        # Second check at even lower price should not trigger again
        triggered_again = svc.check_dutch_alerts("e1", "t1", current_price=40_000)
        assert len(triggered_again) == 0


class TestAllocationResults:
    """Tests for notify_allocation_result()."""

    def test_winner_message(self, svc):
        """Winner notification contains congratulations and price."""
        notif = svc.notify_allocation_result(
            event_id="e1", tier_id="t1", user_id="u1",
            won=True, price=80_000,
        )
        assert notif.type == NotificationType.ALLOCATION_RESULT
        assert "Congratulations" in notif.message
        assert "80,000" in notif.message
        assert notif.data["won"] is True

    def test_loser_message(self, svc):
        """Loser notification contains 'not selected'."""
        notif = svc.notify_allocation_result(
            event_id="e1", tier_id="t1", user_id="u2",
            won=False, explanation="High competition",
        )
        assert "not selected" in notif.message
        assert notif.data["won"] is False

    def test_waitlist_message(self, svc):
        """Waitlisted user sees their position number."""
        notif = svc.notify_allocation_result(
            event_id="e1", tier_id="t1", user_id="u3",
            won=False, waitlist_position=3,
            explanation="Better luck next time",
        )
        assert "#3" in notif.message
        assert notif.data["waitlist_position"] == 3


class TestCancellationOffer:
    """Tests for notify_cancellation_offer()."""

    def test_cancellation_offer_content(self, svc):
        """Cancellation offer includes price and deadline."""
        notif = svc.notify_cancellation_offer(
            event_id="e1", tier_id="t1", user_id="u1",
            price=70_000, deadline_minutes=15,
        )
        assert notif.type == NotificationType.CANCELLATION_OFFER
        assert "70,000" in notif.message
        assert "15 minutes" in notif.message
        assert notif.data["price"] == 70_000
        assert notif.data["deadline_minutes"] == 15


class TestGetAll:
    """Tests for get_all() with event_id filter."""

    def test_get_all_with_event_id_filter(self, svc):
        """get_all(event_id=...) returns only that event's notifications."""
        svc.notify(_make_notif(event_id="e1"))
        svc.notify(_make_notif(event_id="e2"))
        svc.notify(_make_notif(event_id="e1"))

        results = svc.get_all(event_id="e1")
        assert len(results) == 2
        assert all(n.event_id == "e1" for n in results)

    def test_get_all_without_filter_returns_everything(self, svc):
        """get_all() with no filter returns the complete list."""
        svc.notify(_make_notif(event_id="e1"))
        svc.notify(_make_notif(event_id="e2"))

        results = svc.get_all()
        assert len(results) == 2
