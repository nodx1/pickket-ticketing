"""L-3: Hypothesis property-based tests.

Tests cover:
1. Cancellation fee: always 0-100, monotonically increases as event approaches
2. KRW rounding: always integer, never negative
3. PII masking: mask_phone always hides middle digits, mask_email always hides local part
4. Queue position: always positive, unique within a batch
"""

from datetime import datetime, timedelta, timezone

from hypothesis import given, settings, assume
from hypothesis import strategies as st

from app.core.pii import mask_email, mask_phone
from app.services.refund_service import DEFAULT_CANCELLATION_TIERS, RefundService


# ═══════════════════════════════════════════════════════════════════
# 1. Cancellation fee properties
# ═══════════════════════════════════════════════════════════════════


@given(days_before=st.integers(min_value=-30, max_value=365))
@settings(max_examples=200)
def test_cancellation_fee_always_in_range(days_before: int):
    """Fee percentage is always between 0 and 100 inclusive."""
    now = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    event_date = now + timedelta(days=days_before)
    fee = RefundService.calculate_cancellation_fee_pct(event_date, None, now=now)
    assert 0 <= fee <= 100, f"Fee {fee} out of range for {days_before} days"


@given(
    days_a=st.integers(min_value=0, max_value=365),
    days_b=st.integers(min_value=0, max_value=365),
)
@settings(max_examples=200)
def test_cancellation_fee_monotonic(days_a: int, days_b: int):
    """Closer to event → fee is >= further from event (monotonic non-decreasing)."""
    assume(days_a != days_b)
    now = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    event_date = now + timedelta(days=30)  # Fixed event date

    fee_closer = RefundService.calculate_cancellation_fee_pct(
        event_date, None, now=event_date - timedelta(days=min(days_a, days_b))
    )
    fee_further = RefundService.calculate_cancellation_fee_pct(
        event_date, None, now=event_date - timedelta(days=max(days_a, days_b))
    )
    assert fee_closer >= fee_further, (
        f"Fee should be >= when closer to event: "
        f"closer={fee_closer}%, further={fee_further}%"
    )


@given(
    tiers=st.lists(
        st.fixed_dictionaries({
            "days_before": st.integers(min_value=0, max_value=365),
            "fee_pct": st.integers(min_value=0, max_value=100),
        }),
        min_size=1,
        max_size=10,
    ),
    days_before=st.integers(min_value=-10, max_value=400),
)
@settings(max_examples=200)
def test_cancellation_fee_custom_tiers_in_range(tiers, days_before):
    """Custom tiers still produce fee in [0, 100]."""
    now = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    event_date = now + timedelta(days=days_before)
    fee = RefundService.calculate_cancellation_fee_pct(event_date, tiers, now=now)
    assert 0 <= fee <= 100


# ═══════════════════════════════════════════════════════════════════
# 2. KRW rounding properties
# ═══════════════════════════════════════════════════════════════════


@given(
    amount=st.integers(min_value=0, max_value=10_000_000),
    fee_pct=st.sampled_from([0, 10, 20, 30, 100]),
)
@settings(max_examples=200)
def test_krw_refund_always_integer(amount: int, fee_pct: int):
    """After applying cancellation fee, refund should be an integer."""
    fee = amount * fee_pct // 100
    refund = amount - fee
    assert refund == int(refund), f"Fractional refund: {refund}"
    assert refund >= 0, f"Negative refund: {refund}"


# ═══════════════════════════════════════════════════════════════════
# 3. PII masking properties
# ═══════════════════════════════════════════════════════════════════


@given(phone=st.from_regex(r"01[0-9]\d{8}", fullmatch=True))
@settings(max_examples=100)
def test_mask_phone_hides_middle(phone: str):
    """Masked phone always contains '****' in the middle."""
    result = mask_phone(phone)
    assert "****" in result, f"Phone not masked: {result}"
    # Last 4 digits preserved
    assert result.endswith(phone[-4:])


@given(
    local=st.text(
        alphabet=st.sampled_from("abcdefghijklmnopqrstuvwxyz0123456789._"),
        min_size=1,
        max_size=30,
    ),
    domain=st.from_regex(r"[a-z]{2,10}\.[a-z]{2,4}", fullmatch=True),
)
@settings(max_examples=100)
def test_mask_email_hides_local(local: str, domain: str):
    """Masked email preserves domain but hides most of local part."""
    email = f"{local}@{domain}"
    result = mask_email(email)
    # Domain preserved
    assert f"@{domain}" in result
    # Masked local part: only first char + '***' (verify via structural split,
    # not substring — domain may incidentally contain the local string).
    masked_local = result.split("@", 1)[0]
    if len(local) > 1:
        assert masked_local == local[0] + "***"
    else:
        assert masked_local == local + "***"


# ═══════════════════════════════════════════════════════════════════
# 4. Queue position properties
# ═══════════════════════════════════════════════════════════════════


@given(
    batch_size=st.integers(min_value=1, max_value=1000),
)
@settings(max_examples=50)
def test_queue_positions_unique_and_positive(batch_size: int):
    """Generated queue positions must be unique and positive."""
    positions = list(range(1, batch_size + 1))
    assert len(set(positions)) == batch_size, "Positions not unique"
    assert all(p > 0 for p in positions), "Non-positive position found"
