"""
TalkFile Fan Weight System v2
==============================
5-dimensional fan weight with sigmoid normalization and event templates.

Architecture: 3-Layer separation
  Layer 1: Eligibility Gate (see eligibility.py)
  Layer 2: Fan Weight (this module) — 5 dimensions
  Layer 3: Multi-Pool Allocation (see vcg.py + allocations API)

Formula:
  Raw Score = Σ αₖ × sₖ  (k=1..5, Σαₖ = 1)
  wᵢ = 0.5 + 1.5 × σ(κ × (Raw - μ))
  σ(x) = 1/(1+e^(-x)), μ=0.5, κ=6.0

Weight range: [0.57, 1.93] with κ=6

Dimensions:
  s₁ loyalty:   Artist-based loyalty (fanclub tenure, listening, SNS)
  s₂ history:   Attendance history with 2-year half-life decay (exp(-ln2·t/730))
  s₃ fanclub:   Active paid membership
  s₄ behavior:  Trust score (no-show rate, cancel rate inverse)
  s₅ freshness: New user bonus (6-month decay)
"""

import logging
import math
import warnings
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)


# Constants
KAPPA = 6.0       # Sigmoid steepness
MU = 0.5          # Sigmoid center
W_MIN = 0.5       # Weight formula lower bound
W_SCALE = 1.5     # Weight formula scale
ALPHA_MIN = 0.05          # Minimum alpha per dimension
ALPHA_MAX = 0.50          # Maximum alpha per dimension (reduced from 0.65 — prevents single-dimension domination)
ALPHA_MAX_BINARY = 0.40   # Stricter max for binary dimensions (fanclub: 0 or 1) to prevent on/off domination
DECAY_HALFLIFE_DAYS = 730  # 2-year half-life for history
DECAY_LAMBDA = 0.6931471805599453 / 730  # ln(2)/730 ≈ 0.000949 — true 2-year half-life


class EventType(Enum):
    GENERAL_CONCERT = "general_concert"
    FANCLUB_EXCLUSIVE = "fanclub_exclusive"
    FESTIVAL = "festival"
    HIGH_DEMAND_TOUR = "high_demand_tour"
    NEW_ARTIST = "new_artist"
    # Multi-domain extensions
    SPORTS_MATCH = "sports_match"
    SPORTS_PLAYOFF = "sports_playoff"
    EXHIBITION = "exhibition"
    CLASSICAL = "classical"
    ESPORTS = "esports"
    EDUCATION = "education"
    CIVIC_PARTICIPATION = "civic_participation"


@dataclass
class FanScores:
    """Raw dimension scores for a fan, all in [0, 1]."""
    loyalty: float = 0.0      # s₁: artist-based loyalty
    history: float = 0.0      # s₂: attendance history (with decay)
    fanclub: float = 0.0      # s₃: active paid membership (0 or 1)
    behavior: float = 1.0     # s₄: trust score (default perfect for new users)
    freshness: float = 0.0    # s₅: new user bonus

    def validate(self) -> None:
        """Validate and clamp scores to [0, 1]. Raises ValueError on NaN/Inf."""
        for name in ['loyalty', 'history', 'fanclub', 'behavior', 'freshness']:
            val = getattr(self, name)
            if not isinstance(val, (int, float)):
                raise ValueError(f"Score '{name}' must be numeric, got {type(val)}")
            if math.isnan(val) or math.isinf(val):
                raise ValueError(f"Score '{name}' must be finite, got {val}")
            # Clamp to [0, 1]
            setattr(self, name, max(0.0, min(1.0, val)))


@dataclass
class AlphaWeights:
    """Dimension weights (must sum to 1.0, each in [0.05, 0.65])."""
    loyalty: float = 0.30
    history: float = 0.25
    fanclub: float = 0.15
    behavior: float = 0.15
    freshness: float = 0.15

    def validate(self) -> None:
        """Validate alpha constraints.

        Rules:
          - Each αₖ ∈ [ALPHA_MIN, ALPHA_MAX]
          - Binary dimensions (fanclub) ∈ [ALPHA_MIN, ALPHA_MAX_BINARY]
          - Σαₖ = 1.0
        """
        names = ["loyalty", "history", "fanclub", "behavior", "freshness"]
        values = [self.loyalty, self.history, self.fanclub, self.behavior, self.freshness]
        # Binary dimension indices (fanclub is index 2)
        binary_dims = {2}

        for i, v in enumerate(values):
            upper = ALPHA_MAX_BINARY if i in binary_dims else ALPHA_MAX
            if v < ALPHA_MIN - 1e-9 or v > upper + 1e-9:
                raise ValueError(
                    f"Alpha '{names[i]}' = {v:.3f} outside [{ALPHA_MIN}, {upper}]"
                )
        total = sum(values)
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"Alpha sum = {total:.6f}, must equal 1.0")

    def to_list(self) -> list[float]:
        return [self.loyalty, self.history, self.fanclub, self.behavior, self.freshness]


# Pre-defined event templates
# Constraints: each αₖ ∈ [0.05, 0.50], fanclub ∈ [0.05, 0.40], Σ=1.0
EVENT_TEMPLATES: dict[EventType, AlphaWeights] = {
    # Original 5 templates (unchanged)
    EventType.GENERAL_CONCERT: AlphaWeights(0.30, 0.25, 0.15, 0.15, 0.15),
    EventType.FANCLUB_EXCLUSIVE: AlphaWeights(0.20, 0.15, 0.40, 0.10, 0.15),
    EventType.FESTIVAL: AlphaWeights(0.15, 0.10, 0.05, 0.20, 0.50),
    EventType.HIGH_DEMAND_TOUR: AlphaWeights(0.35, 0.30, 0.10, 0.15, 0.10),
    EventType.NEW_ARTIST: AlphaWeights(0.10, 0.05, 0.05, 0.30, 0.50),
    # Multi-domain extensions
    EventType.SPORTS_MATCH: AlphaWeights(0.20, 0.30, 0.15, 0.20, 0.15),
    EventType.SPORTS_PLAYOFF: AlphaWeights(0.25, 0.35, 0.20, 0.15, 0.05),
    EventType.EXHIBITION: AlphaWeights(0.10, 0.15, 0.10, 0.15, 0.50),
    EventType.CLASSICAL: AlphaWeights(0.15, 0.20, 0.20, 0.20, 0.25),
    EventType.ESPORTS: AlphaWeights(0.15, 0.25, 0.15, 0.15, 0.30),
    EventType.EDUCATION: AlphaWeights(0.20, 0.15, 0.10, 0.20, 0.35),
    EventType.CIVIC_PARTICIPATION: AlphaWeights(0.15, 0.15, 0.10, 0.25, 0.35),
}


def validate_template_only(event_type_str: str) -> EventType:
    """Validate that an event type string corresponds to a known template.

    Args:
        event_type_str: String value of the EventType enum.

    Returns:
        The resolved EventType enum value.

    Raises:
        ValueError: If the string does not match any key in EVENT_TEMPLATES.
    """
    try:
        et = EventType(event_type_str)
    except ValueError:
        valid_keys = [e.value for e in EVENT_TEMPLATES.keys()]
        raise ValueError(
            f"Unknown event type '{event_type_str}'. "
            f"Valid templates: {valid_keys}"
        )
    if et not in EVENT_TEMPLATES:
        valid_keys = [e.value for e in EVENT_TEMPLATES.keys()]
        raise ValueError(
            f"Event type '{event_type_str}' has no template. "
            f"Valid templates: {valid_keys}"
        )
    return et


def sigmoid(x: float) -> float:
    """Standard sigmoid function σ(x) = 1/(1+e^(-x))."""
    if x < -500:
        return 0.0
    if x > 500:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def compute_raw_score(scores: FanScores, alphas: AlphaWeights) -> float:
    """Compute weighted raw score Σ αₖ × sₖ."""
    s = [scores.loyalty, scores.history, scores.fanclub, scores.behavior, scores.freshness]
    a = alphas.to_list()
    return sum(si * ai for si, ai in zip(s, a))


def compute_fan_weight_v2(
    scores: FanScores,
    alphas: AlphaWeights | None = None,
    event_type: EventType | None = None,
) -> float:
    """
    Compute fan weight from 5-dimensional scores.

    w = 0.5 + 1.5 × σ(κ × (Raw - μ))

    Args:
        scores: Fan's dimension scores
        alphas: **Deprecated.** Custom alpha weights are ignored since WP04
            (template-only mode). Passing this parameter emits a deprecation
            warning and a log message; the event_type template is used instead.
        event_type: Event type for template lookup
    Returns:
        Weight in approximately [0.57, 1.93]
    """
    scores.validate()

    # WP04: alphas parameter is deprecated — always use template
    if alphas is not None:
        warnings.warn(
            "compute_fan_weight_v2(): 'alphas' parameter is deprecated and ignored. "
            "Use 'event_type' to select a template instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        logger.warning(
            "compute_fan_weight_v2 called with custom alphas (ignored). "
            "Template-only mode enforced since WP04. event_type=%s",
            event_type,
        )

    if event_type is not None:
        resolved_alphas = EVENT_TEMPLATES[event_type]
    else:
        resolved_alphas = EVENT_TEMPLATES[EventType.GENERAL_CONCERT]

    resolved_alphas.validate()

    raw = compute_raw_score(scores, resolved_alphas)
    w = W_MIN + W_SCALE * sigmoid(KAPPA * (raw - MU))
    return round(w, 6)


def compute_history_score(
    attendances: list[tuple[int, int]] | None = None,
    max_count: int = 50,
) -> float:
    """
    Compute history score with 2-year exponential decay.

    Args:
        attendances: List of (days_ago, count) tuples
        max_count: Maximum count for normalization
    Returns:
        Score in [0, 1]
    """
    if not attendances:
        return 0.0

    total = 0.0
    for days_ago, count in attendances:
        # True 2-year half-life: decay = exp(-ln2 × t / 730)
        # At t=730 days: decay = 0.5 exactly
        decay = math.exp(-DECAY_LAMBDA * days_ago)
        total += decay * math.log(1 + count) / math.log(1 + max_count)

    return min(1.0, total)


def compute_freshness_score(days_since_signup: int) -> float:
    """
    Compute freshness score (linear decay over 6 months).

    Returns 1.0 on signup day, 0.0 after 180 days.
    """
    if days_since_signup < 0:
        return 1.0
    if days_since_signup >= 180:
        return 0.0
    return 1.0 - (days_since_signup / 180.0)


def compute_behavior_score(
    no_show_rate: float = 0.0,
    cancel_rate: float = 0.0,
    dispute_rate: float = 0.0,
) -> float:
    """
    Compute behavior/trust score.
    s₄ = 1 - (0.5 × no_show_rate + 0.3 × cancel_rate + 0.2 × dispute_rate)
    """
    score = 1.0 - (0.5 * no_show_rate + 0.3 * cancel_rate + 0.2 * dispute_rate)
    return max(0.0, min(1.0, score))


# Category → EventType mapping for multi-domain resolution
CATEGORY_EVENT_TYPE_MAP: dict[str, EventType] = {
    "concert": EventType.GENERAL_CONCERT,
    "musical": EventType.GENERAL_CONCERT,
    "sports": EventType.SPORTS_MATCH,
    "classical": EventType.CLASSICAL,
    "exhibition": EventType.EXHIBITION,
    "festival": EventType.FESTIVAL,
    "education": EventType.EDUCATION,
    "civic": EventType.CIVIC_PARTICIPATION,
}


def resolve_event_type(
    category: str | None = None,
    sub_category: str | None = None,
    override: str | None = None,
) -> EventType:
    """Resolve EventType from category/sub_category with optional override.

    Args:
        category: Event category slug (e.g. "sports", "concert")
        sub_category: Sub-category for refinement (e.g. "e스포츠" → ESPORTS)
        override: Direct EventType value string override (from community.event_type_template)
    Returns:
        Resolved EventType
    """
    # Override takes precedence
    if override:
        try:
            return EventType(override)
        except ValueError:
            pass

    # Sub-category refinement
    if sub_category:
        sub_lower = sub_category.lower()
        if "e스포츠" in sub_lower or "esports" in sub_lower:
            return EventType.ESPORTS
        if "플레이오프" in sub_lower or "playoff" in sub_lower:
            return EventType.SPORTS_PLAYOFF

    # Category mapping
    if category:
        cat_lower = category.lower()
        return CATEGORY_EVENT_TYPE_MAP.get(cat_lower, EventType.GENERAL_CONCERT)

    return EventType.GENERAL_CONCERT


def compute_loyalty_score(
    fanclub_tenure_months: float = 0.0,
    listening_hours_yearly: float = 0.0,
    sns_follow_months: float = 0.0,
) -> float:
    """
    Compute artist-based loyalty score.
    Average of normalized sub-scores. Default 0.5 if no external data.
    """
    sub_scores = []
    has_data = False

    if fanclub_tenure_months > 0:
        sub_scores.append(min(1.0, fanclub_tenure_months / 60.0))
        has_data = True
    else:
        sub_scores.append(0.0)

    if listening_hours_yearly > 0:
        sub_scores.append(min(1.0, listening_hours_yearly / 500.0))
        has_data = True
    else:
        sub_scores.append(0.0)

    if sns_follow_months > 0:
        sub_scores.append(min(1.0, sns_follow_months / 36.0))
        has_data = True
    else:
        sub_scores.append(0.0)

    if not has_data:
        return 0.5  # Neutral default when no external data available

    return sum(sub_scores) / len(sub_scores)
