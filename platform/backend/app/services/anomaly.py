"""Simple anomaly detection for bid patterns."""

import numpy as np
from dataclasses import dataclass


@dataclass
class AnomalyResult:
    is_anomalous: bool
    score: float  # 0-1
    reasons: list[str]


def detect_bid_anomaly(
    bid_amount: float,
    quantity: int,
    user_bid_count_24h: int,
    all_bids_amounts: list[float],
    user_account_age_days: int,
    *,
    ip_address: str | None = None,
    user_agent: str | None = None,
    same_ip_user_count: int = 0,
    same_device_user_count: int = 0,
    user_previous_anomaly_score: float = 0.0,
) -> AnomalyResult:
    """Detect anomalous bid patterns using Z-score and rules."""
    reasons = []
    score = 0.0

    # Rule 1: Z-score check
    if len(all_bids_amounts) >= 5:
        mean = np.mean(all_bids_amounts)
        std = np.std(all_bids_amounts)
        if std > 0:
            z = abs(bid_amount - mean) / std
            if z > 3:
                reasons.append(f"Price Z-score {z:.1f} > 3")
                score += 0.4

    # Rule 2: Rapid bidding
    if user_bid_count_24h > 10:
        reasons.append(f"High bid frequency: {user_bid_count_24h} in 24h")
        score += 0.3

    # Rule 3: New account + max quantity
    if user_account_age_days < 1 and quantity >= 4:
        reasons.append("New account with max quantity")
        score += 0.3

    # Rule 4: Max quantity + very high price
    if quantity == 4 and len(all_bids_amounts) >= 5:
        p95 = np.percentile(all_bids_amounts, 95)
        if bid_amount > p95:
            reasons.append("Max quantity at premium price")
            score += 0.2

    # Rule 5: Same IP used by many users
    if same_ip_user_count >= 3:
        reasons.append(f"Same IP used by {same_ip_user_count} users")
        score += 0.3

    # Rule 6: Same device fingerprint used by many users
    if same_device_user_count >= 2:
        reasons.append(f"Same device used by {same_device_user_count} users")
        score += 0.35

    # Rule 7: Previous anomaly history
    if user_previous_anomaly_score >= 0.3:
        reasons.append(f"Previous anomaly history (avg score: {user_previous_anomaly_score:.2f})")
        score += 0.2

    return AnomalyResult(
        is_anomalous=score >= 0.5,
        score=min(score, 1.0),
        reasons=reasons,
    )
