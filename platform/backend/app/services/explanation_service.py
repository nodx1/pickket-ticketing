"""
Explanation Service
====================
Generates human-readable explanations for allocation outcomes
using engine's AllocationExplainer.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.explanation import AllocationExplainer
from talkfile_engine.vcg import AllocationOutput, WinnerOutput

from app.models.allocation import Allocation, AllocationResult, AllocationStatus
from app.models.bid import Bid, BidStatus
from app.models.event import Event


class ExplanationService:
    """Service for generating allocation result explanations."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def explain_result(self, event_id: uuid.UUID, user_id: uuid.UUID) -> dict:
        """
        Generate an explanation for a user's allocation result.

        Loads the allocation and determines whether the user won or lost,
        then uses engine's AllocationExplainer to generate an appropriate
        explanation.

        Args:
            event_id: Event UUID.
            user_id: User UUID.

        Returns:
            Dict with explanation data:
            - won: bool
            - explanation: dict (varies by win/loss)

        Raises:
            ValueError: If allocation or bid not found.
        """
        # Load allocation
        alloc_result = await self.session.execute(
            select(Allocation).where(
                Allocation.event_id == event_id,
                Allocation.status == AllocationStatus.COMPLETED,
            )
        )
        allocation = alloc_result.scalar_one_or_none()
        if not allocation:
            raise ValueError(f"No completed allocation found for event {event_id}")

        # Load event for price cap info
        event_result = await self.session.execute(select(Event).where(Event.id == event_id))
        event = event_result.scalar_one_or_none()

        # Load all allocation results to build AllocationOutput
        results_query = await self.session.execute(
            select(AllocationResult).where(AllocationResult.allocation_id == allocation.id)
        )
        all_results = list(results_query.scalars().all())

        # Load corresponding bids for all results
        bid_ids = [r.bid_id for r in all_results]
        bids_query = await self.session.execute(select(Bid).where(Bid.id.in_(bid_ids)))
        bids_by_id = {b.id: b for b in bids_query.scalars().all()}

        # Build engine AllocationOutput from DB data
        engine_winners: list[WinnerOutput] = []
        for r in all_results:
            bid = bids_by_id.get(r.bid_id)
            if not bid:
                continue
            engine_winners.append(
                WinnerOutput(
                    bid_id=str(r.bid_id),
                    user_id=str(r.user_id),
                    bid_amount=bid.max_willingness_to_pay,
                    effective_weight=bid.effective_weight or 1.0,
                    weighted_value=bid.max_willingness_to_pay * (bid.effective_weight or 1.0),
                    vcg_price=r.vcg_price,
                    externality=r.externality,
                    final_price=r.final_price,
                )
            )

        engine_output = AllocationOutput(
            winners=engine_winners,
            total_bids=allocation.total_bids,
            total_seats=allocation.total_allocated,
            competition_ratio=allocation.competition_ratio,
            price_min=allocation.price_min or 0.0,
            price_max=allocation.price_max or 0.0,
            price_median=allocation.price_median or 0.0,
            cutoff_price=allocation.cutoff_price or 0.0,
            gini_coefficient=allocation.gini_coefficient or 0.0,
        )

        explainer = AllocationExplainer()

        # Check if user is a winner
        user_result = None
        for r in all_results:
            if r.user_id == user_id:
                user_result = r
                break

        if user_result:
            # User is a winner
            bid = bids_by_id.get(user_result.bid_id)
            if not bid:
                raise ValueError("Bid not found for allocation result")

            winner = WinnerOutput(
                bid_id=str(user_result.bid_id),
                user_id=str(user_result.user_id),
                bid_amount=bid.max_willingness_to_pay,
                effective_weight=bid.effective_weight or 1.0,
                weighted_value=bid.max_willingness_to_pay * (bid.effective_weight or 1.0),
                vcg_price=user_result.vcg_price,
                externality=user_result.externality,
                final_price=user_result.final_price,
            )

            price_cap = 0.0
            if event and allocation.tier_id:
                from app.models.event import SeatTier

                tier_result = await self.session.execute(
                    select(SeatTier).where(SeatTier.id == allocation.tier_id)
                )
                tier = tier_result.scalar_one_or_none()
                if tier:
                    price_cap = tier.max_price_cap

            explanation = explainer.explain_winner(winner, engine_output, price_cap)

            return {
                "won": True,
                "fair_price": user_result.vcg_price,  # DB 컬럼명 유지
                "final_price": user_result.final_price,
                "externality": user_result.externality,
                "explanation": {
                    "price_percentile": explanation.price_percentile,
                    "weight_effect_pct": explanation.weight_effect_pct,
                    "savings_vs_uniform": explanation.savings_vs_uniform,
                    "consumer_surplus": explanation.consumer_surplus,
                    "fairness_statement": explanation.fairness_statement,
                },
            }
        else:
            # User is a loser — find their bid
            bid_result = await self.session.execute(
                select(Bid).where(
                    Bid.event_id == event_id,
                    Bid.user_id == user_id,
                    Bid.status == BidStatus.LOST,
                )
            )
            bid = bid_result.scalar_one_or_none()
            if not bid:
                # Try active/cancelled bids as well
                bid_result = await self.session.execute(
                    select(Bid)
                    .where(
                        Bid.event_id == event_id,
                        Bid.user_id == user_id,
                    )
                    .order_by(Bid.created_at.desc())
                )
                bid = bid_result.scalars().first()

            if not bid:
                raise ValueError(f"No bid found for user {user_id} in event {event_id}")

            weight = bid.effective_weight or 1.0
            explanation = explainer.explain_loser(
                bid_amount=bid.max_willingness_to_pay,
                weight=weight,
                allocation=engine_output,
            )

            return {
                "won": False,
                "bid_amount": bid.max_willingness_to_pay,
                "effective_weight": weight,
                "explanation": {
                    "margin_to_win": explanation.margin_to_win,
                    "was_narrow_miss": explanation.was_narrow_miss,
                    "constructive_note": explanation.constructive_note,
                },
            }
