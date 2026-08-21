import random

import numpy as np

from talkfile_engine.fan_weight import (
    FanScores,
    compute_fan_weight_v2,
    resolve_event_type,
)
from talkfile_engine.vcg import AllocationInput, BidInput, VCGEngine


class RehearsalService:
    def __init__(self):
        self.engine = VCGEngine()

    def generate_virtual_bids(
        self,
        *,
        num_bids: int = 100,
        min_price: float,
        max_price: float,
        category: str = "concert",
        seed: int | None = None,
    ) -> list[dict]:
        """Generate virtual bids for rehearsal simulation."""
        if num_bids <= 0:
            raise ValueError("num_bids must be positive")
        if min_price <= 0 or max_price <= 0:
            raise ValueError("prices must be positive")
        if min_price > max_price:
            raise ValueError("min_price cannot be greater than max_price")

        event_type = resolve_event_type(category=category)
        rng = np.random.default_rng(seed)
        py_rng = random.Random(seed)

        mean_log = np.log((min_price + max_price) / 2.0)
        std_log = 0.3
        prices = rng.lognormal(mean=mean_log, sigma=std_log, size=num_bids)
        prices = np.clip(prices, min_price, max_price)

        qty_weights = [0.70, 0.20, 0.08, 0.02]
        bids: list[dict] = []

        for i in range(num_bids):
            qty = py_rng.choices([1, 2, 3, 4], weights=qty_weights, k=1)[0]
            scores = FanScores(
                loyalty=py_rng.uniform(0.0, 1.0),
                history=py_rng.uniform(0.0, 1.0),
                fanclub=1.0 if py_rng.random() < 0.3 else 0.0,
                behavior=py_rng.uniform(0.6, 1.0),
                freshness=py_rng.uniform(0.0, 1.0),
            )
            weight = compute_fan_weight_v2(scores, event_type=event_type)
            bids.append(
                {
                    "bid_id": f"virtual_bid_{i}",
                    "user_id": f"virtual_user_{i}",
                    "bid_amount": round(float(prices[i]), 0),
                    "quantity": qty,
                    "weight": weight,
                }
            )

        return bids

    def run_simulation(
        self,
        *,
        total_seats: int,
        min_price: float,
        max_price: float,
        num_bids: int = 100,
        category: str = "concert",
        seed: int | None = None,
    ) -> dict:
        """리허설 시뮬레이션 실행 (공정 배분 엔진 사용)."""
        if total_seats <= 0:
            raise ValueError("total_seats must be positive")

        virtual_bids = self.generate_virtual_bids(
            num_bids=num_bids,
            min_price=min_price,
            max_price=max_price,
            category=category,
            seed=seed,
        )

        bid_inputs = [
            BidInput(
                bid_id=b["bid_id"],
                user_id=b["user_id"],
                max_willingness_to_pay=float(b["bid_amount"]),
                effective_weight=float(b["weight"]),
                quantity=int(b["quantity"]),
            )
            for b in virtual_bids
        ]

        alloc_input = AllocationInput(
            bids=bid_inputs,
            total_seats=total_seats,
            min_price=min_price,
        )
        result = self.engine.allocate(alloc_input)

        final_prices = [w.final_price for w in result.winners]
        bid_amounts = [b["bid_amount"] for b in virtual_bids]

        if final_prices:
            price_stats = {
                "min": round(min(final_prices)),
                "max": round(max(final_prices)),
                "median": round(float(np.median(final_prices))),
                "p25": round(float(np.percentile(final_prices, 25))),
                "p75": round(float(np.percentile(final_prices, 75))),
                "mean": round(float(np.mean(final_prices))),
            }
        else:
            price_stats = {}

        winners_sorted = sorted(result.winners, key=lambda w: w.final_price, reverse=True)
        top_winners = [
            {
                "bid_amount": round(w.bid_amount),
                "final_price": round(w.final_price),
                "savings": round(max(0.0, w.bid_amount - w.final_price)),
                "fan_weight": round(w.effective_weight, 2),
            }
            for w in winners_sorted[:10]
        ]

        total_requested_qty = sum(int(b["quantity"]) for b in virtual_bids)
        mean_final_price = float(np.mean(final_prices)) if final_prices else 0.0

        return {
            "total_bids": len(virtual_bids),
            "total_seats": total_seats,
            "competition_ratio": round(total_requested_qty / max(total_seats, 1), 2),
            "winners_count": len(result.winners),
            "price_stats": price_stats,
            "estimated_revenue": round(sum(final_prices)),
            "fair_vs_face_price_ratio": round(
                (mean_final_price / max_price) * 100.0,
                1,
            )
            if final_prices and max_price > 0
            else 0.0,
            "bids_summary": {
                "count_by_quantity": {
                    q: sum(1 for b in virtual_bids if b["quantity"] == q) for q in [1, 2, 3, 4]
                },
                "price_distribution": {
                    "mean": round(float(np.mean(bid_amounts))),
                    "std": round(float(np.std(bid_amounts))),
                },
            },
            "top_winners": top_winners,
        }
