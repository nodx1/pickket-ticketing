"""
TalkFile Eligibility Gate (Layer 1)
====================================
Determines participation eligibility per pool.

Verification levels:
  Level 0: Email only       → Pool C only
  Level 1: Phone verified   → Pool A, B, C
  Level 2: Real-name (PASS) → Pool A, B, C, D
  Level 3: Foreign alt-ID   → Same as Level 2

Abuse filter:
  Rule-based detection (not AI). Blocks if abuse_score > threshold.
  Does NOT affect fan weight — binary gate only.

Pool allocation order: A → D → B → C
  Pool A (65%): Weighted VCG — verified users, w_i based
  Pool B (15%): New user lottery — signup < 6 months, Level 1+, uniform
  Pool C (10%): General lottery — all users (including unverified), w=1.0
  Pool D (10%): Fanclub guaranteed — Level 2+, fanclub members, w_i priority
"""

import math
from collections import Counter
from dataclasses import dataclass, field
from enum import IntEnum


class VerificationLevel(IntEnum):
    UNVERIFIED = 0      # Email only
    PHONE = 1           # Phone verified
    REAL_NAME = 2       # PASS / government ID
    FOREIGN_ALT = 3     # Passport / global ID (equivalent to REAL_NAME)


class Pool(IntEnum):
    A = 0  # Weighted VCG (65%)
    B = 1  # New user lottery (15%)
    C = 2  # General lottery (10%)
    D = 3  # Fanclub guaranteed (10%)


# Default pool ratios
DEFAULT_POOL_RATIOS: dict[Pool, float] = {
    Pool.A: 0.65,
    Pool.B: 0.15,
    Pool.C: 0.10,
    Pool.D: 0.10,
}

# Allocation order
POOL_ALLOCATION_ORDER = [Pool.A, Pool.D, Pool.B, Pool.C]

# Abuse detection threshold
ABUSE_THRESHOLD = 0.7


@dataclass
class UserEligibility:
    """A user's eligibility profile."""
    user_id: str
    verification_level: VerificationLevel = VerificationLevel.UNVERIFIED
    is_new_user: bool = False      # signup < 6 months
    is_fanclub_member: bool = False
    abuse_score: float = 0.0       # 0.0 = clean, 1.0 = definite abuse


@dataclass
class EligibilityResult:
    """Result of eligibility check."""
    user_id: str
    eligible_pools: list[Pool] = field(default_factory=list)
    is_blocked: bool = False
    block_reason: str = ""


def check_eligibility(user: UserEligibility) -> EligibilityResult:
    """
    Determine which pools a user can participate in.

    Rules:
    - Abuse score > threshold → blocked entirely
    - Level 0 → Pool C only
    - Level 1 → Pool A, B (if new), C
    - Level 2/3 → Pool A, B (if new), C, D (if fanclub)
    """
    if user.abuse_score > ABUSE_THRESHOLD:
        return EligibilityResult(
            user_id=user.user_id,
            is_blocked=True,
            block_reason="Abuse detection threshold exceeded. Appeal within 24 hours.",
        )

    pools: list[Pool] = []
    level = user.verification_level

    # Level 3 (foreign) treated same as Level 2
    effective_level = min(level, VerificationLevel.REAL_NAME)

    if effective_level >= VerificationLevel.PHONE:
        pools.append(Pool.A)
        if user.is_new_user:
            pools.append(Pool.B)

    if effective_level >= VerificationLevel.REAL_NAME and user.is_fanclub_member:
        pools.append(Pool.D)

    # Everyone can participate in Pool C
    pools.append(Pool.C)

    return EligibilityResult(user_id=user.user_id, eligible_pools=pools)


def compute_pool_seats(total_seats: int, ratios: dict[Pool, float] | None = None) -> dict[Pool, int]:
    """
    Compute seat allocation per pool.

    Ensures total matches exactly by giving remainder to Pool A.
    """
    if ratios is None:
        ratios = DEFAULT_POOL_RATIOS

    seats: dict[Pool, int] = {}
    allocated = 0

    for pool in POOL_ALLOCATION_ORDER:
        if pool == Pool.A:
            continue  # A gets the remainder
        n = int(total_seats * ratios.get(pool, 0.0))
        seats[pool] = n
        allocated += n

    seats[Pool.A] = total_seats - allocated
    return seats


def compute_abuse_score(
    multi_account_same_ip: int = 0,
    rapid_cancel_count: int = 0,
    bot_signature_detected: bool = False,
) -> float:
    """
    Rule-based abuse score computation.
    Returns score in [0.0, 1.0].
    """
    score = 0.0

    if multi_account_same_ip >= 3:
        score += 0.3
    elif multi_account_same_ip >= 2:
        score += 0.1

    if rapid_cancel_count >= 5:
        score += 0.3
    elif rapid_cancel_count >= 3:
        score += 0.15

    if bot_signature_detected:
        score += 0.5

    return min(1.0, score)


def _roundness_factor(amount: int) -> float:
    """Return discount factor for round number bid amounts.

    Round numbers (100k, 150k, 200k) naturally cluster in real ticket auctions.
    Higher factor = more discount applied to suspicion score.
    """
    if amount == 0:
        return 1.0
    if amount % 100000 == 0:
        return 3.0
    if amount % 50000 == 0:
        return 2.5
    if amount % 10000 == 0:
        return 2.0
    if amount % 5000 == 0:
        return 1.5
    if amount % 1000 == 0:
        return 1.2
    return 1.0


@dataclass
class CollusionSignal:
    """Batch-level collusion detection signals."""
    bid_similarity_score: float = 0.0    # Identical bid amount clusters
    timing_cluster_score: float = 0.0     # Coordinated submission timing
    payment_cluster_score: float = 0.0    # Shared payment method clusters
    overall_score: float = 0.0            # Weighted aggregate


def detect_collusion_signals(
    bids: list[dict],
    total_seats: int,
) -> CollusionSignal:
    """
    Detect collusion patterns across a batch of bids.

    Each bid dict should have: user_id, bid_amount, submit_time (float, epoch seconds),
    payment_method_hash (str or None).

    Pattern 1 — Bid Similarity:
      If N users bid the exact same amount (rounded to integer) and N > sqrt(total_bids),
      this is suspicious. Organic bids follow a distribution.

    Pattern 2 — Timing Clusters:
      If multiple bids arrive within a very short window (< 2 seconds) from different
      users, this suggests automated/coordinated submission.

    Pattern 3 — Payment Method Clustering:
      If multiple different users share the same payment method hash, strong sybil signal.
    """
    if not bids or total_seats <= 0:
        return CollusionSignal()

    n = len(bids)
    threshold = math.sqrt(n) if n > 0 else 1

    # Pattern 1: Bid similarity (with round number discount)
    # Round numbers (100k, 150k, etc.) naturally attract clusters in real auctions.
    # Discount suspicion for round amounts to reduce false positives.
    amount_counts = Counter(round(b.get("bid_amount", 0)) for b in bids)
    if amount_counts:
        most_common_amount, max_same = amount_counts.most_common(1)[0]
        raw_similarity = max(0.0, (max_same - threshold) / threshold) if threshold > 0 else 0.0
        roundness = _roundness_factor(int(most_common_amount))
        similarity = min(1.0, raw_similarity / roundness)
    else:
        similarity = 0.0

    # Pattern 2: Timing clusters
    timing_score = 0.0
    times = sorted(b.get("submit_time", 0.0) for b in bids if b.get("submit_time") is not None)
    if len(times) >= 2:
        # Count pairs within 2 seconds
        close_pairs = 0
        for i in range(len(times) - 1):
            if times[i + 1] - times[i] < 2.0:
                close_pairs += 1
        timing_score = min(1.0, close_pairs / threshold) if threshold > 0 else 0.0

    # Pattern 3: Payment method clustering
    payment_score = 0.0
    payment_hashes = [b.get("payment_method_hash") for b in bids if b.get("payment_method_hash")]
    if payment_hashes:
        pm_counts = Counter(payment_hashes)
        max_shared = max(pm_counts.values()) if pm_counts else 0
        if max_shared > 1:
            payment_score = min(1.0, (max_shared - 1) / threshold) if threshold > 0 else 0.0

    # Weighted aggregate
    overall = 0.3 * similarity + 0.3 * timing_score + 0.4 * payment_score

    return CollusionSignal(
        bid_similarity_score=round(similarity, 4),
        timing_cluster_score=round(timing_score, 4),
        payment_cluster_score=round(payment_score, 4),
        overall_score=round(overall, 4),
    )
