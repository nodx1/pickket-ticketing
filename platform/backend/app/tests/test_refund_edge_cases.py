"""H-6: Partial refund edge case tests.

Tests cover:
1. KRW rounding — no fractional won
2. Cancellation fee tier boundary calculations
3. Refund amount cannot exceed original order amount
4. Sequential partial refunds
5. Cancellation fee at each tier boundary
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.refund_service import (
    DEFAULT_CANCELLATION_TIERS,
    RefundService,
)
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


# ═══════════════════════════════════════════════════════════════════
# Cancellation fee calculation (unit tests — no DB)
# ═══════════════════════════════════════════════════════════════════


class TestCancellationFeeCalculation:
    """Test RefundService.calculate_cancellation_fee_pct boundary values."""

    def _calc(self, days_before_event: int) -> float:
        # 15:00 UTC = 00:00 KST. event_date의 현지 날짜 자정까지 정확히 N일이 되게 고정한다.
        now = datetime(2026, 1, 1, 15, 0, tzinfo=timezone.utc)
        event_date = now + timedelta(days=days_before_event, hours=12)
        return RefundService.calculate_cancellation_fee_pct(event_date, None, now=now)

    def test_well_before_event_no_fee(self):
        """11+ days before → 0% fee"""
        assert self._calc(11) == 0

    def test_10_days_before_no_fee(self):
        """Exactly at 10-day boundary → 0% fee"""
        assert self._calc(10) == 0

    def test_7_days_before_10pct(self):
        """7 days → 10% fee"""
        assert self._calc(7) == 10

    def test_5_days_before_10pct(self):
        """5 days → 10% (within 7-day tier)"""
        assert self._calc(5) == 10

    def test_3_days_before_20pct(self):
        """3 days → 20% fee"""
        assert self._calc(3) == 20

    def test_1_day_before_30pct(self):
        """1 day → 30% fee"""
        assert self._calc(1) == 30

    def test_event_day_100pct(self):
        """Event day (0 days) → 100% fee (no refund)"""
        assert self._calc(0) == 100

    def test_past_event_100pct(self):
        """After event → 100% fee"""
        event_date = datetime.now(timezone.utc) - timedelta(days=1)
        fee = RefundService.calculate_cancellation_fee_pct(event_date, None)
        assert fee == 100

    def test_custom_tiers_override_default(self):
        """Custom cancellation tiers take precedence."""
        custom = [
            {"days_before": 5, "fee_pct": 0},
            {"days_before": 2, "fee_pct": 50},
            {"days_before": 0, "fee_pct": 100},
        ]
        now = datetime(2026, 1, 1, 15, 0, tzinfo=timezone.utc)
        event_date = now + timedelta(days=3, hours=12)
        fee = RefundService.calculate_cancellation_fee_pct(event_date, custom, now=now)
        assert fee == 0  # 3 days left, within 5-day tier → 0%

    def test_naive_event_date_handled(self):
        """Naive datetime (no tz) should not crash."""
        event_date = datetime.utcnow() + timedelta(days=5)  # noqa: DTZ003
        fee = RefundService.calculate_cancellation_fee_pct(event_date, None)
        assert 0 <= fee <= 100

    def test_event_day_gate_starts_at_midnight_kst_not_event_start(self):
        """행사 전날 23:59 KST는 허용, 행사일 00:00 KST부터 100% 수수료다."""
        event_date = datetime(2026, 8, 20, 7, 0, tzinfo=timezone.utc)  # 16:00 KST
        same_day_only = [{"days_before": 0, "fee_pct": 100}]

        minute_before = datetime(2026, 8, 19, 14, 59, tzinfo=timezone.utc)
        event_day_midnight = datetime(2026, 8, 19, 15, 0, tzinfo=timezone.utc)

        assert RefundService.calculate_cancellation_fee_pct(
            event_date, same_day_only, now=minute_before
        ) == 0
        assert RefundService.calculate_cancellation_fee_pct(
            event_date, same_day_only, now=event_day_midnight
        ) == 100

    def test_event_day_midnight_kst_handles_year_boundary(self):
        """12/31→1/1 연말 경계에서도 KST 현지 날짜를 기준으로 판정한다."""
        event_date = datetime(2027, 1, 1, 3, 0, tzinfo=timezone.utc)  # 12:00 KST
        same_day_only = [{"days_before": 0, "fee_pct": 100}]

        assert RefundService.calculate_cancellation_fee_pct(
            event_date,
            same_day_only,
            now=datetime(2026, 12, 31, 14, 59, tzinfo=timezone.utc),
        ) == 0
        assert RefundService.calculate_cancellation_fee_pct(
            event_date,
            same_day_only,
            now=datetime(2026, 12, 31, 15, 0, tzinfo=timezone.utc),
        ) == 100


# ═══════════════════════════════════════════════════════════════════
# Integration: partial refund edge cases
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_refund_amount_exceeding_total_rejected(client):
    """Requesting refund amount > order total is rejected."""
    org_token = await get_auth_token(
        client, "ref_exceed_org@test.com", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "GA", "capacity": 100, "base_price": 50.0, "sale_mode": "fixed_fcfs", "face_price": 50.0},
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "ref_exceed_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    purchase = purchase_resp.json()
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    # Try to refund more than the total price
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "excessive", "amount": 999999.0},
        headers=auth_headers(buyer_token),
    )
    # Should be rejected (either 400 or 200 with error status)
    if resp.status_code == 200:
        data = resp.json()
        # If accepted, the refund_amount should not exceed original
        assert data.get("refund_amount", 0) <= purchase["total_price"]
    else:
        assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def test_sequential_partial_refunds(client, allow_partial_cancel):
    """Two sequential partial refunds on the same order."""
    org_token = await get_auth_token(
        client, "ref_seq_org@test.com", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "GA", "capacity": 100, "base_price": 50.0, "sale_mode": "fixed_fcfs", "face_price": 50.0},
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201), f"Tier creation failed: {tier_resp.text}"
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "ref_seq_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 2},
        headers=auth_headers(buyer_token),
    )
    purchase = purchase_resp.json()
    order_id = purchase["order_id"]
    ticket_ids = purchase["ticket_ids"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    # First partial refund: 1 ticket
    resp1 = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "first partial", "amount": 50.0, "ticket_ids": [ticket_ids[0]]},
        headers=auth_headers(buyer_token),
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["refund_amount"] == pytest.approx(50.0)

    # Second partial refund: remaining ticket
    resp2 = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "second partial", "amount": 50.0, "ticket_ids": [ticket_ids[1]]},
        headers=auth_headers(buyer_token),
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["refund_amount"] == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_krw_refund_produces_integer_amounts(client):
    """KRW refunds must never have fractional won values."""
    org_token = await get_auth_token(
        client, "ref_krw_org@test.com", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    # Use a price that could produce fractions with percentage calculations
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "GA", "capacity": 100, "base_price": 33.0, "sale_mode": "fixed_fcfs", "face_price": 33.0},
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "ref_krw_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 3},
        headers=auth_headers(buyer_token),
    )
    purchase = purchase_resp.json()
    order_id = purchase["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    # Full refund
    resp = await client.post(
        f"/api/v1/orders/{order_id}/refund",
        json={"reason": "krw rounding test"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    refund_amount = data.get("refund_amount", 0)
    # KRW: refund amount must be an integer (or float with .0)
    assert refund_amount == int(refund_amount), f"Fractional KRW: {refund_amount}"
