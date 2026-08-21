"""
TalkFile Allocation Explanation Engine
========================================
Generates human-readable explanations for allocation outcomes.

Behavioral economics foundation:
  - Fehr & Schmidt (1999): Inequity aversion — explain WHY prices differ
  - Loomes & Sugden (1982): Regret theory — help losers with constructive feedback
  - Thaler (1985): Transaction utility — frame savings as "honesty reward"

Design principle: frame weight as "fan recognition" not "price discrimination".
"""

from dataclasses import dataclass
from talkfile_engine.vcg import WinnerOutput, AllocationOutput


@dataclass
class WinnerExplanation:
    """Explanation for a winning bidder."""
    price_percentile: float         # Price rank among winners (0-100)
    weight_effect_pct: float        # How much weight saved them (%)
    savings_vs_uniform: float       # Monetary savings vs w=1.0 pricing
    consumer_surplus: float         # bid - final_price
    fairness_statement: str         # Human-readable fairness note


@dataclass
class LoserExplanation:
    """Explanation for a losing bidder."""
    margin_to_win: float | None     # How much more weighted value was needed
    was_narrow_miss: bool           # Within 10% of cutoff
    constructive_note: str          # Actionable improvement suggestion


class AllocationExplainer:
    """Generates explanations for allocation outcomes."""

    def explain_winner(
        self, winner: WinnerOutput, allocation: AllocationOutput,
        price_cap: float = 0.0,
    ) -> WinnerExplanation:
        """Generate explanation for a winning bidder."""
        all_prices = sorted(w.final_price for w in allocation.winners)
        n = len(all_prices)

        # Price percentile (lower = cheaper = better)
        # Use strict-less-than rank to handle ties correctly:
        # paying the minimum price → 0th percentile (cheapest)
        rank_below = sum(1 for p in all_prices if p < winner.final_price)
        percentile = (rank_below / (n - 1)) * 100 if n > 1 else 0.0

        # Weight effect: at w=1.0, price would be externality (vcg_price * w_i)
        uniform_price = winner.externality  # externality = vcg_price * w_i
        savings = uniform_price - winner.final_price
        savings_pct = (savings / uniform_price * 100) if uniform_price > 0 else 0.0

        surplus = winner.bid_amount - winner.final_price

        # Fairness statement
        if price_cap > 0 and winner.final_price >= price_cap:
            statement = (
                "Your price was capped at the consumer protection limit. "
                "All winners were priced by the same VCG formula with the same cap."
            )
        elif savings > 0:
            statement = (
                f"Your fan recognition saved you {savings_pct:.0f}%. "
                f"All winners were priced by the same VCG formula."
            )
        else:
            statement = (
                "You paid the minimum amount necessary for your seat. "
                "All winners were priced by the same VCG formula."
            )

        return WinnerExplanation(
            price_percentile=round(percentile, 1),
            weight_effect_pct=round(max(0, savings_pct), 1),
            savings_vs_uniform=round(max(0, savings), 2),
            consumer_surplus=round(surplus, 2),
            fairness_statement=statement,
        )

    def explain_loser(
        self,
        bid_amount: float,
        weight: float,
        allocation: AllocationOutput,
    ) -> LoserExplanation:
        """Generate explanation for a losing bidder."""
        bid_wv = bid_amount * weight
        cutoff = allocation.cutoff_price

        if cutoff > 0 and bid_wv < cutoff:
            margin = cutoff - bid_wv
            was_narrow = (margin / cutoff) < 0.10
        else:
            margin = None
            was_narrow = False

        # Constructive note based on situation
        if was_narrow:
            note = (
                "You were very close to winning! "
                "Building fan history or joining the fanclub can improve your chances next time."
            )
        elif weight < 1.0:
            note = (
                "Completing fan verification and building attendance history "
                "can significantly improve your fan weight for future events."
            )
        else:
            note = (
                "Competition was high for this event. "
                "Consider joining the waitlist for reallocation opportunities."
            )

        return LoserExplanation(
            margin_to_win=round(margin, 2) if margin is not None else None,
            was_narrow_miss=was_narrow,
            constructive_note=note,
        )
