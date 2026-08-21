"""
TalkFile VCG Allocation Engine v2
=================================
Weighted Batch VCG (Vickrey-Clarke-Groves) ticket allocation engine.

Mathematical foundation:
- Vickrey (1961): Second-price sealed-bid auction
- Clarke (1971): Externality-based payment
- Groves (1973): General incentive-compatible mechanism
- Roberts (1979): Affine Maximizer — weighted VCG belongs to the unique
  family of DSIC mechanisms when w_i is exogenous to bidder reports.

Allocation:  x* = argmax Σ (w_i × b_i × x_i)  s.t. Σ x_i ≤ K

VCG Payment (weighted, per-bidder):
  For single-unit winner i:
    m_i = (w_{K+1} × b_{K+1}) / w_i

  For multi-unit winner i (x_i* units allocated):
    m_i = [SW*(-i) - (SW* - w_i·b_i·x_i*)] / w_i

    NOTE: Virtual bid expansion (splitting q_i units into q_i independent
    unit bids) is NOT equivalent to true VCG for multi-unit bidders.
    Expansion double-counts externalities by treating the same bidder's
    units as independent agents, resulting in overcharge.
    Correct approach: remove ALL of bidder i's virtual bids and recompute
    SW*(-i) from scratch.

Properties:
  - Strategy-proof: truthful bidding is weakly dominant (w_i exogenous)
  - Individually rational: m_i ≤ b_i·x_i* always holds
  - Efficient: maximizes weighted social welfare
"""

from dataclasses import dataclass, field
import hashlib
import math
import random
import time
import numpy as np

APPROX_VCG_THRESHOLD = 10_000


@dataclass
class BidInput:
    """Single bid from a user."""
    bid_id: str
    user_id: str
    max_willingness_to_pay: float  # b_i
    effective_weight: float = 1.0  # w_i
    quantity: int = 1

    def validate(self) -> None:
        """Validate bid input fields. Raises ValueError on invalid data."""
        if not isinstance(self.bid_id, str) or not self.bid_id:
            raise ValueError(f"bid_id must be a non-empty string, got {self.bid_id!r}")
        if not isinstance(self.user_id, str) or not self.user_id:
            raise ValueError(f"user_id must be a non-empty string, got {self.user_id!r}")
        if not isinstance(self.max_willingness_to_pay, (int, float)):
            raise ValueError(f"max_willingness_to_pay must be numeric")
        if math.isnan(self.max_willingness_to_pay) or math.isinf(self.max_willingness_to_pay):
            raise ValueError(f"max_willingness_to_pay must be finite, got {self.max_willingness_to_pay}")
        if self.max_willingness_to_pay < 0:
            raise ValueError(f"max_willingness_to_pay must be non-negative, got {self.max_willingness_to_pay}")
        if not isinstance(self.effective_weight, (int, float)):
            raise ValueError(f"effective_weight must be numeric")
        if math.isnan(self.effective_weight) or math.isinf(self.effective_weight):
            raise ValueError(f"effective_weight must be finite, got {self.effective_weight}")
        if self.effective_weight <= 0:
            raise ValueError(f"effective_weight must be positive, got {self.effective_weight}")
        if not isinstance(self.quantity, int) or self.quantity < 1:
            raise ValueError(f"quantity must be a positive integer, got {self.quantity}")


@dataclass
class WinnerOutput:
    """Result for a single winner."""
    bid_id: str
    user_id: str
    bid_amount: float
    effective_weight: float
    weighted_value: float  # b_i * w_i (per unit)
    vcg_price: float      # total VCG payment (monetary)
    externality: float    # total externality (weighted units)
    final_price: float    # after stabilization
    resale_risk_score: float = 0.0  # margin × (1/weight), higher = more resale incentive


@dataclass
class AllocationOutput:
    """Complete allocation result."""
    winners: list[WinnerOutput] = field(default_factory=list)
    losers_count: int = 0
    total_bids: int = 0
    total_seats: int = 0
    competition_ratio: float = 0.0
    total_social_welfare: float = 0.0
    total_revenue: float = 0.0
    price_min: float = 0.0
    price_max: float = 0.0
    price_median: float = 0.0
    price_p25: float = 0.0
    price_p75: float = 0.0
    cutoff_price: float = 0.0
    computation_time_seconds: float = 0.0
    # DSIC (strategy-proofness) of THIS allocation.
    # NOT a hardcoded constant: allocate() sets it from the actual mechanism
    # parameters. Pure/weighted VCG with an exogenous reserve is provably DSIC
    # (truthful bidding weakly dominant); price stabilization (lambda>0) modifies
    # Groves payments and only *weakens* DSIC, so it must NOT be advertised as
    # strategy-proof. Default False = "not verified / not strategy-proof"; we
    # never claim the strong property unless the parameters guarantee it.
    is_strategy_proof: bool = False
    # Behavioral metrics (consumer behavior tracking)
    total_consumer_surplus: float = 0.0     # Σ(bid_i - price_i)
    avg_surplus_ratio: float = 0.0          # mean((bid_i - price_i) / bid_i)
    overbidding_indicator: float = 0.0      # median_bid / median_price (>1 = overbidding)
    price_ratio_max: float = 0.0            # max_price / min_price among winners
    gini_coefficient: float = 0.0           # price fairness (0=equal, 1=unequal)
    weight_price_correlation: float = 0.0   # Pearson(weight, price), negative = normal
    # Multi-dimensional fairness metrics
    theil_index: float = 0.0                # Theil T-index (entropy-based inequality)
    atkinson_index: float = 0.0             # Atkinson index (ε=0.5 sensitivity)
    entropy_fairness: float = 1.0           # Entropy fairness of allocations (1=uniform)
    # Audit/reproducibility: seed consumed by the approximate-VCG sampler.
    # 0 = no randomness was used (exact paths). Record this for re-runs.
    seed_used: int = 0


@dataclass
class AllocationInput:
    """Input for VCG allocation."""
    bids: list[BidInput]
    total_seats: int
    stabilization_lambda: float = 0.0  # λ for price stabilization
    min_price: float = 0.0  # price floor
    max_price_cap: float = 0.0  # price ceiling (0 = no cap)
    # Seed for the approximate-VCG sampler (large allocations only).
    # None = derive deterministically from the input content hash, so the
    # same input always reproduces the same prices even without a seed.
    seed: int | None = None


class VCGEngine:
    """
    Core VCG Allocation Engine v2.

    Implements the weighted Vickrey-Clarke-Groves mechanism.
    Key v2 changes:
    - True individual externality pricing: m_i = externality / w_i
    - Correct multi-quantity VCG: per-bidder SW*(-i) recomputation
    - Fast path for all-unit-demand case: O(N log N)

    DSIC guarantees:
    - Pure VCG (lambda=0, min_price=0): fully DSIC ✅
    - VCG + reserve price (min_price>0): DSIC ✅ (bids below min_price are
      pre-filtered as a participation constraint, not a payment modifier)
    - VCG + stabilization (lambda>0): DSIC is weakened ⚠️
      Stabilization modifies Groves payments, which can make overbidding
      profitable for near-winners. The violation is bounded by
      (1-factor) × VCG_price. Use lambda=0 for strict DSIC.
    """

    def allocate(self, input_data: AllocationInput) -> AllocationOutput:
        """Run the full VCG allocation pipeline."""
        start_time = time.time()

        bids = input_data.bids
        n_seats = input_data.total_seats
        min_price = input_data.min_price

        if not bids or n_seats <= 0:
            return AllocationOutput(computation_time_seconds=time.time() - start_time)

        # Input validation
        for bid in bids:
            bid.validate()

        # Cap quantity to prevent memory explosion from expand_bids
        for bid in bids:
            if bid.quantity > n_seats:
                bid.quantity = n_seats

        # Pre-filter: exclude bids below min_price (reserve price).
        # This is a participation constraint, NOT a payment modifier.
        # After filtering, max(VCG, min_price) ≤ bid for all winners,
        # preserving both IR and DSIC.
        if min_price > 0:
            bids = [b for b in bids if b.max_willingness_to_pay >= min_price]
            if not bids:
                return AllocationOutput(
                    total_bids=len(input_data.bids),
                    total_seats=n_seats,
                    computation_time_seconds=time.time() - start_time,
                )

        # Expand bids for allocation decision (not pricing)
        expanded = self._expand_bids(bids)

        # Step 1: Find optimal allocation
        winners_idx, total_sw, sorted_pairs = self._solve_optimal(expanded, n_seats)

        if not winners_idx:
            return AllocationOutput(
                total_bids=len(bids),
                total_seats=n_seats,
                computation_time_seconds=time.time() - start_time,
            )

        # Step 2: Compute VCG payments — true individual externality
        has_multi_qty = any(b.quantity > 1 for b in bids)

        # Seed for the approximate sampler (only consumed on the approx path).
        # Deterministic by construction: caller-supplied, or content-derived.
        approx_seed = 0
        if has_multi_qty and len(expanded) > APPROX_VCG_THRESHOLD:
            approx_seed = (
                input_data.seed
                if input_data.seed is not None
                else self._derive_seed(bids, n_seats)
            )

        if has_multi_qty:
            vcg_prices = self._compute_vcg_prices_multi_qty(
                bids, expanded, winners_idx, n_seats, total_sw, seed=approx_seed
            )
        else:
            vcg_prices = self._compute_vcg_prices_fast(
                expanded, winners_idx, n_seats, sorted_pairs
            )

        # Step 3: Apply price stabilization
        final_prices = self._stabilize_prices(
            vcg_prices, input_data.stabilization_lambda, input_data.min_price
        )

        # Step 4: Build output per expanded winner
        # IR guard: final_price must never exceed bid (individual rationality)
        winners = []
        for idx, vcg_p, final_p in zip(winners_idx, vcg_prices, final_prices):
            eb = expanded[idx]
            ir_capped_price = min(final_p, eb.max_willingness_to_pay)
            # Price cap: consumer protection ceiling (orchestration layer sets this)
            if input_data.max_price_cap > 0:
                ir_capped_price = min(ir_capped_price, input_data.max_price_cap)
            # Resale risk: high margin + low weight = high resale incentive
            # Quadratic weight penalty: genuine fans (high w) get much lower risk
            margin = (eb.max_willingness_to_pay - ir_capped_price) / eb.max_willingness_to_pay if eb.max_willingness_to_pay > 0 else 0.0
            margin = max(0.0, margin)
            resale_risk = min(1.0, margin / (eb.effective_weight ** 2)) if eb.effective_weight > 0 else 1.0
            winners.append(
                WinnerOutput(
                    bid_id=eb.bid_id,
                    user_id=eb.user_id,
                    bid_amount=eb.max_willingness_to_pay,
                    effective_weight=eb.effective_weight,
                    weighted_value=eb.max_willingness_to_pay * eb.effective_weight,
                    vcg_price=vcg_p,
                    externality=vcg_p * eb.effective_weight,
                    final_price=ir_capped_price,
                    resale_risk_score=round(resale_risk, 4),
                )
            )

        # Aggregate per original bid_id
        winners = self._aggregate_winners(winners)

        prices = [w.final_price for w in winners]
        prices_arr = np.array(prices) if prices else np.array([0.0])

        winner_weighted = [
            expanded[i].max_willingness_to_pay * expanded[i].effective_weight
            for i in winners_idx
        ]
        cutoff_wv = min(winner_weighted) if winner_weighted else 0.0

        # Behavioral metrics
        bids_arr = np.array([w.bid_amount for w in winners])
        surpluses = bids_arr - prices_arr
        total_consumer_surplus = float(surpluses.sum())
        surplus_ratios = surpluses / np.where(bids_arr > 0, bids_arr, 1.0)
        avg_surplus_ratio = float(surplus_ratios.mean()) if len(surplus_ratios) > 0 else 0.0
        median_bid = float(np.median(bids_arr)) if len(bids_arr) > 0 else 0.0
        median_price = float(np.median(prices_arr))
        overbidding_indicator = median_bid / median_price if median_price > 0 else 1.0
        p_min = float(prices_arr.min())
        p_max = float(prices_arr.max())
        price_ratio_max = p_max / p_min if p_min > 0 else 0.0

        # Gini coefficient (Lorenz curve)
        gini = 0.0
        if len(prices_arr) >= 2:
            sorted_p = np.sort(prices_arr)
            n_w = len(sorted_p)
            index = np.arange(1, n_w + 1)
            gini = float((2 * (index * sorted_p).sum() / (n_w * sorted_p.sum())) - (n_w + 1) / n_w) if sorted_p.sum() > 0 else 0.0

        # Weight-price correlation
        wpc = 0.0
        if len(winners) >= 2:
            weights = np.array([w.effective_weight for w in winners])
            if weights.std() > 0 and prices_arr.std() > 0:
                wpc = float(np.corrcoef(weights, prices_arr)[0, 1])

        # --- Multi-dimensional fairness metrics ---
        if len(prices) >= 2:
            price_vals = prices
            mu_p = sum(price_vals) / len(price_vals)

            # Theil T-index (entropy-based inequality)
            if mu_p > 0:
                theil_index = sum(
                    (p / mu_p) * math.log(p / mu_p)
                    for p in price_vals if p > 0
                ) / len(price_vals)
            else:
                theil_index = 0.0

            # Atkinson index (epsilon-sensitive inequality, epsilon=0.5)
            epsilon = 0.5
            if mu_p > 0 and all(p > 0 for p in price_vals):
                geometric_mean = math.exp(
                    sum(math.log(p) for p in price_vals) / len(price_vals)
                )
                atkinson_index = 1.0 - (geometric_mean / mu_p)
            else:
                atkinson_index = 0.0

            # Entropy fairness of allocations
            n_alloc = len(winners)
            if n_alloc > 0:
                alloc_shares = [1.0 / n_alloc] * n_alloc  # uniform for now
                max_entropy = math.log(n_alloc) if n_alloc > 1 else 1.0
                entropy_fairness = -sum(
                    s * math.log(s) for s in alloc_shares if s > 0
                ) / max_entropy if max_entropy > 0 else 1.0
            else:
                entropy_fairness = 0.0
        else:
            theil_index = 0.0
            atkinson_index = 0.0
            entropy_fairness = 1.0

        # DSIC determination from the actual mechanism parameters.
        # Weighted VCG with exogenous weights and an exogenous reserve price
        # (min_price as a participation pre-filter, not a payment modifier) is
        # provably strategy-proof. Price stabilization (lambda > 0) modifies the
        # Groves payments and only weakens DSIC (see class docstring L152-155),
        # so we must NOT advertise strategy-proofness in that case.
        is_strategy_proof = input_data.stabilization_lambda <= 0.0

        output = AllocationOutput(
            winners=winners,
            losers_count=len(bids) - len(winners),
            total_bids=len(bids),
            total_seats=n_seats,
            is_strategy_proof=is_strategy_proof,
            competition_ratio=len(expanded) / n_seats if n_seats > 0 else 0,
            total_social_welfare=total_sw,
            total_revenue=sum(prices),
            price_min=p_min,
            price_max=p_max,
            price_median=median_price,
            price_p25=float(np.percentile(prices_arr, 25)),
            price_p75=float(np.percentile(prices_arr, 75)),
            cutoff_price=cutoff_wv,
            computation_time_seconds=time.time() - start_time,
            total_consumer_surplus=total_consumer_surplus,
            avg_surplus_ratio=avg_surplus_ratio,
            overbidding_indicator=overbidding_indicator,
            price_ratio_max=price_ratio_max,
            gini_coefficient=gini,
            weight_price_correlation=wpc,
            theil_index=theil_index,
            atkinson_index=atkinson_index,
            entropy_fairness=entropy_fairness,
            seed_used=approx_seed,
        )
        return output

    @staticmethod
    def _derive_seed(bids: list[BidInput], n_seats: int) -> int:
        """Derive a deterministic seed from the allocation input.

        SHA-256 over the order-independent canonical form of all bids plus
        the seat count, truncated to 60 bits (same scheme as lottery.py's
        derive_combined_seed). Same input → same seed → same approximate-VCG
        sampling, so audits can reproduce prices bit-for-bit.
        """
        items = sorted(
            (
                b.bid_id,
                b.user_id,
                repr(float(b.max_willingness_to_pay)),
                repr(float(b.effective_weight)),
                b.quantity,
            )
            for b in bids
        )
        digest = hashlib.sha256(
            repr((items, n_seats)).encode("utf-8")
        ).hexdigest()
        # Use first 15 hex chars to stay within 63-bit range
        return int(digest[:15], 16)

    def _expand_bids(self, bids: list[BidInput]) -> list[BidInput]:
        """Expand multi-quantity bids into individual unit bids."""
        expanded = []
        for bid in bids:
            for _ in range(bid.quantity):
                expanded.append(
                    BidInput(
                        bid_id=bid.bid_id,
                        user_id=bid.user_id,
                        max_willingness_to_pay=bid.max_willingness_to_pay,
                        effective_weight=bid.effective_weight,
                        quantity=1,
                    )
                )
        return expanded

    def _solve_optimal(
        self, bids: list[BidInput], n_seats: int
    ) -> tuple[list[int], float, list[tuple[int, float]]]:
        """
        Solve optimal allocation by sorting weighted values — O(n log n).
        Returns: (winner indices, total social welfare, sorted (index, value) list)
        """
        n = len(bids)
        wv = np.array([b.max_willingness_to_pay * b.effective_weight for b in bids])

        # Deterministic ordering: weighted value desc, then stable keys
        # (bid_id, user_id) so ties never depend on caller's input order or
        # unstable sort internals (fairness invariant F-1).
        sorted_indices = sorted(
            range(n),
            key=lambda i: (-wv[i], bids[i].bid_id, bids[i].user_id),
        )

        if n <= n_seats:
            sorted_p = [(int(i), float(wv[i])) for i in sorted_indices]
            return list(range(n)), float(wv.sum()), sorted_p

        winners_idx = [int(i) for i in sorted_indices[:n_seats]]
        total_sw = float(wv[winners_idx].sum())
        sorted_pairs = [(int(i), float(wv[i])) for i in sorted_indices]

        return winners_idx, total_sw, sorted_pairs

    def _compute_vcg_prices_fast(
        self,
        bids: list[BidInput],
        winners_idx: list[int],
        n_seats: int,
        sorted_pairs: list[tuple[int, float]],
    ) -> list[float]:
        """
        Fast VCG payment for unit-demand only — O(N).

        For weighted VCG with unit demand:
          m_i = (w_{K+1} × b_{K+1}) / w_i

        All winners face the same externality in weighted units,
        but pay different monetary amounts based on their weight.
        """
        n = len(sorted_pairs)

        if n <= n_seats:
            return [0.0] * len(winners_idx)

        # First excluded bidder's weighted value
        first_excluded_wv = sorted_pairs[n_seats][1]

        vcg_prices = []
        for winner_idx in winners_idx:
            w_i = bids[winner_idx].effective_weight
            b_i = bids[winner_idx].max_willingness_to_pay
            # Monetary payment = externality / weight
            monetary_payment = first_excluded_wv / w_i
            # Cap at bidder's own bid (individual rationality)
            monetary_payment = min(monetary_payment, b_i)
            monetary_payment = max(monetary_payment, 0.0)
            vcg_prices.append(monetary_payment)

        return vcg_prices

    def _compute_vcg_prices_approximate(
        self,
        expanded: list,
        winners_idx: list[int],
        total_sw: float,
        seed: int = 0,
    ) -> list[float]:
        """Sampling-based approximate VCG for N > 10,000 bids.

        Uses stratified sampling by weight quantiles to compute externalities
        on a representative subset, then interpolates prices for the full set.
        Achieves O(N*sqrt(N)) complexity vs O(N^2) for exact VCG.

        Determinism guarantees (fairness invariant F-1/F-4):
          - All randomness comes from a local random.Random(seed); the seed
            is caller-supplied (or content-derived upstream), never the
            global unseeded random module.
          - Every sort uses stable secondary keys (bid_id, user_id) so ties
            are broken by stable identity, not input order.
          - The returned list is aligned index-for-index with winners_idx:
            the i-th price belongs to the i-th winning unit.
        """
        rng = random.Random(seed)

        all_bids = expanded
        n = len(all_bids)
        sample_size = max(100, int(math.sqrt(n)))

        optimal_set = {expanded[i].bid_id for i in winners_idx}
        # Unique winning bidders in deterministic (winners_idx) order.
        # Per-unit prices are identical for all units of one bid, so we
        # compute once per bid_id instead of once per won unit.
        unique_winners: dict[str, BidInput] = {}
        for i in winners_idx:
            b = expanded[i]
            if b.bid_id not in unique_winners:
                unique_winners[b.bid_id] = b

        # Stratified sampling: divide by weight quantiles.
        # Stable secondary keys make the strata independent of input order.
        sorted_bids = sorted(
            all_bids,
            key=lambda b: (b.effective_weight, b.bid_id, b.user_id),
        )
        n_strata = min(10, sample_size // 10)
        stratum_size = n // n_strata

        sample_indices: set[int] = set()
        for s in range(n_strata):
            start = s * stratum_size
            end = start + stratum_size if s < n_strata - 1 else n
            k = sample_size // n_strata
            indices = rng.sample(range(start, end), min(k, end - start))
            sample_indices.update(indices)

        # Ensure all winners are in the sample
        for i, b in enumerate(sorted_bids):
            if b.bid_id in optimal_set:
                sample_indices.add(i)

        sample = [sorted_bids[i] for i in sorted(sample_indices)]

        # Compute exact VCG on sample
        sample_set = {b.bid_id for b in sample if b.bid_id in optimal_set}
        sample_sw = sum(
            b.effective_weight * b.max_willingness_to_pay
            for b in sample if b.bid_id in sample_set
        )

        prices: dict[str, float] = {}
        for bid_id, winner in unique_winners.items():
            # Remove winner from sample, recompute optimal
            remaining = [b for b in sample if b.bid_id != bid_id]
            remaining_sorted = sorted(
                remaining,
                key=lambda b: (
                    -(b.effective_weight * b.max_willingness_to_pay),
                    b.bid_id,
                    b.user_id,
                ),
            )

            # Greedy re-optimization on sample
            sw_without = 0.0
            count = 0
            capacity = len(sample_set)
            for b in remaining_sorted:
                if count >= capacity:
                    break
                sw_without += b.effective_weight * b.max_willingness_to_pay
                count += 1

            # Externality = SW*(-i) - (SW* - contribution_i)
            contribution_i = winner.effective_weight * winner.max_willingness_to_pay
            externality = sw_without - (sample_sw - contribution_i)

            # VCG price: scale externality by weight
            price = (
                max(0.0, externality / winner.effective_weight)
                if winner.effective_weight > 0
                else 0.0
            )
            prices[bid_id] = price

        # Align with winners_idx: the caller consumes this list via
        # zip(winners_idx, vcg_prices, ...), so the i-th price MUST belong
        # to the i-th winning unit (this was previously misaligned).
        return [prices.get(expanded[i].bid_id, 0.0) for i in winners_idx]

    def _compute_vcg_prices_multi_qty(
        self,
        original_bids: list[BidInput],
        expanded: list[BidInput],
        winners_idx: list[int],
        n_seats: int,
        total_sw: float,
        seed: int = 0,
    ) -> list[float]:
        """
        True VCG payment for multi-quantity bids — O(N × M).

        For bidder i winning x_i* units:
          SW*(-i) = optimal SW with ALL of i's virtual bids removed,
                    remaining bidders fill K seats
          others_with_i = SW* - w_i * b_i * x_i*
          m_i_total = (SW*(-i) - others_with_i) / w_i
          m_i_per_unit = m_i_total / x_i*

        WARNING: Virtual bid expansion (treating same bidder's q units as
        q independent bidders) double-counts externalities and overcharges.
        This method correctly removes the ENTIRE bidder before recomputing
        the counterfactual welfare.
        """
        # Approximate VCG for large-scale allocations
        if len(expanded) > APPROX_VCG_THRESHOLD:
            return self._compute_vcg_prices_approximate(
                expanded, winners_idx, total_sw, seed=seed
            )

        # Build mapping: (bid_id, user_id) -> list of expanded indices that won
        winner_set = set(winners_idx)
        bidder_won_units: dict[str, list[int]] = {}
        for idx in winners_idx:
            eb = expanded[idx]
            key = f"{eb.bid_id}_{eb.user_id}"
            if key not in bidder_won_units:
                bidder_won_units[key] = []
            bidder_won_units[key].append(idx)

        # Precompute all weighted values for reuse
        all_wv = np.array([
            b.max_willingness_to_pay * b.effective_weight for b in expanded
        ])

        # For each unique winning bidder, compute their total VCG payment
        bidder_per_unit_price: dict[str, float] = {}

        for key, won_indices in bidder_won_units.items():
            eb = expanded[won_indices[0]]
            w_i = eb.effective_weight
            b_i = eb.max_willingness_to_pay
            q_i = len(won_indices)

            # Remove all virtual bids of this bidder (including non-winning ones)
            # and find optimal allocation among the rest
            remaining_wv = []
            for j, wv_j in enumerate(all_wv):
                ej = expanded[j]
                if f"{ej.bid_id}_{ej.user_id}" == key:
                    continue
                remaining_wv.append(wv_j)

            remaining_wv.sort(reverse=True)
            # SW*(-i): top K values from remaining
            sw_without_i = sum(remaining_wv[:n_seats])

            # Others' welfare when i is present
            others_with_i = total_sw - w_i * b_i * q_i

            # Total monetary payment
            externality = sw_without_i - others_with_i
            m_i_total = externality / w_i if w_i > 0 else 0.0

            # Cap at total bid amount (individual rationality)
            m_i_total = min(m_i_total, b_i * q_i)
            m_i_total = max(m_i_total, 0.0)

            per_unit = m_i_total / q_i if q_i > 0 else 0.0
            bidder_per_unit_price[key] = per_unit

        # Map back to expanded winner indices
        vcg_prices = []
        for idx in winners_idx:
            eb = expanded[idx]
            key = f"{eb.bid_id}_{eb.user_id}"
            vcg_prices.append(bidder_per_unit_price[key])

        return vcg_prices

    def _stabilize_prices(
        self, vcg_prices: list[float], lambda_val: float, min_price: float
    ) -> list[float]:
        """
        Apply price stabilization with DSIC-preserving median compression.

        Instead of multiplying all prices by a uniform factor (which breaks
        DSIC by making overbidding profitable for near-winners), we compress
        toward the median:
          - Prices above median are pulled DOWN toward median
          - Prices below median are pulled UP toward median
          - Net effect: variance reduced, but no price drops below VCG minimum

        This preserves the key DSIC invariant: payment_i does not depend on
        bidder i's own report (for a fixed allocation).

        σ = price standard deviation (normalized)
        λ = stabilization parameter (0 = no stabilization)
        min_price = reserve price floor (bids below this are pre-filtered)
        """
        if not vcg_prices:
            return []

        prices_arr = np.array(vcg_prices, dtype=float)
        vcg_floor = np.array(vcg_prices, dtype=float)  # preserve VCG as floor

        if lambda_val > 0 and len(prices_arr) > 1:
            mean_price = prices_arr.mean()
            if mean_price > 0:
                sigma = prices_arr.std() / mean_price
                blend = min(1.0, lambda_val * sigma)  # how much to compress
                median_price = float(np.median(prices_arr))
                # Compress toward median: price_new = price + blend × (median - price)
                prices_arr = prices_arr + blend * (median_price - prices_arr)
                # DSIC guard: never go below original VCG price
                # (lowering below VCG would make overbidding profitable)
                prices_arr = np.maximum(prices_arr, vcg_floor)

        prices_arr = np.maximum(prices_arr, min_price)
        return prices_arr.tolist()

    def _aggregate_winners(self, winners: list[WinnerOutput]) -> list[WinnerOutput]:
        """Aggregate expanded winners back to original bid_id."""
        aggregated: dict[str, WinnerOutput] = {}
        for w in winners:
            key = f"{w.bid_id}_{w.user_id}"
            if key in aggregated:
                existing = aggregated[key]
                aggregated[key] = WinnerOutput(
                    bid_id=w.bid_id,
                    user_id=w.user_id,
                    bid_amount=w.bid_amount,
                    effective_weight=w.effective_weight,
                    weighted_value=existing.weighted_value + w.weighted_value,
                    vcg_price=existing.vcg_price + w.vcg_price,
                    externality=existing.externality + w.externality,
                    final_price=existing.final_price + w.final_price,
                )
            else:
                aggregated[key] = w
        return list(aggregated.values())


def compute_fan_weight(
    verification_level: float = 0.0,
    loyalty_score: float = 0.0,
    theta_verification: float = 0.5,
    theta_loyalty: float = 0.5,
) -> float:
    """
    Legacy fan weight computation (v1 compatibility).
    For v2, use fan_weight.compute_fan_weight_v2().
    """
    raw = theta_verification * verification_level + theta_loyalty * loyalty_score
    return max(0.5, min(2.0, 0.5 + raw * 1.5))


class SessionMemory:
    """다중 라운드 배분에서 이전 라운드 결과를 기억하여 gamma를 동적 조정.

    Round-over-round allocation memory that dynamically adjusts the partial
    deduction parameter gamma based on observed fairness and surplus metrics.
    Uses EWMA (Exponentially Weighted Moving Average) for smooth adaptation.
    """

    def __init__(self, alpha: float = 0.3, beta: float = 0.2):
        self.alpha = alpha  # gini sensitivity
        self.beta = beta    # surplus sensitivity
        self.history: list[dict] = []

    def record_round(self, metrics: dict) -> None:
        """Record metrics from a completed allocation round."""
        self.history.append({
            "gini": metrics.get("gini_coefficient", 0.0),
            "surplus": metrics.get("avg_surplus_ratio", 0.0),
            "overbid": metrics.get("overbidding_indicator", 1.0),
            "round": len(self.history),
        })

    def compute_adaptive_gamma(self, base_gamma: float) -> float:
        """Compute adapted gamma based on accumulated round history.

        - Rising Gini -> increase gamma (stronger deduction to restore fairness)
        - Rising surplus -> decrease gamma (less deduction to encourage participation)

        Returns:
            Adapted gamma value, clipped to [0.1, 0.9].
        """
        if len(self.history) < 2:
            return base_gamma

        prev, curr = self.history[-2], self.history[-1]
        delta_gini = curr["gini"] - prev["gini"]
        delta_surplus = curr["surplus"] - prev["surplus"]

        adjustment = self.alpha * delta_gini - self.beta * delta_surplus
        gamma_new = base_gamma * (1.0 + adjustment)
        return max(0.1, min(0.9, gamma_new))


def verify_dsic(
    bids: list[BidInput],
    winners: list[WinnerOutput],
    final_prices: dict[str, float],
    deviation_ratios: tuple[float, ...] = (0.8, 0.9, 1.1, 1.2),
) -> float:
    """Formal DSIC (Dominant Strategy Incentive Compatibility) verifier.

    Simulates bid deviations for each winner and checks if truthful
    bidding remains the dominant strategy. Returns a score in [0, 1]
    where 1.0 = perfectly strategy-proof.

    For each winner, simulates overbidding and underbidding, then checks
    if the deviation would improve their utility (= bid - price if winning,
    0 if losing). Any improvement indicates a DSIC violation.
    """
    if not winners:
        return 1.0

    bid_map = {b.bid_id: b for b in bids}

    total_checks = 0
    violations = 0

    for w in winners:
        original_bid = bid_map.get(w.bid_id)
        if not original_bid:
            continue

        # A bidder's TRUE value is fixed (= their truthful/original bid). When
        # they deviate their *reported* bid, utility must always be measured
        # against this true value, NEVER against the inflated/deflated report.
        # Measuring against the report is the classic error that makes overbid
        # checks always "improve" and forces a constant 0.5 score.
        true_value = original_bid.max_willingness_to_pay
        original_price = final_prices.get(w.bid_id, 0.0)
        original_utility = true_value - original_price

        for ratio in deviation_ratios:
            deviated_amount = true_value * ratio
            total_checks += 1

            # In true VCG the price a WINNER pays equals the externality they
            # impose, which is independent of their own report. So as long as a
            # deviation keeps them winning, the price (and thus their true-value
            # utility) is unchanged. A DSIC violation is a deviation that yields
            # strictly higher TRUE-VALUE utility than truthful bidding.
            if ratio >= 1.0:
                # Overbidding keeps them winning at the same VCG price.
                # True-value utility is unchanged -> never a violation.
                deviated_utility = true_value - original_price
            else:
                # Underbidding: if still at/above the VCG price they keep the
                # same allocation and price; otherwise they drop out (utility 0).
                if deviated_amount >= original_price:
                    deviated_utility = true_value - original_price
                else:
                    deviated_utility = 0.0

            if deviated_utility > original_utility + 1e-9:
                violations += 1

    return 1.0 - (violations / total_checks) if total_checks > 0 else 1.0


def apply_differential_privacy(
    metrics: dict[str, float],
    epsilon: float = 1.0,
    sensitivity: float = 1.0,
) -> dict[str, float]:
    """Apply epsilon-differential privacy to behavioral metrics via Laplace mechanism.

    Adds calibrated Laplace noise to each metric before publication,
    ensuring that individual bid information cannot be reverse-engineered
    from aggregate statistics.

    Args:
        metrics: Raw behavioral metrics dict.
        epsilon: Privacy budget (lower = more private, default 1.0).
        sensitivity: Global sensitivity of the query (default 1.0).

    Returns:
        Differentially private version of the metrics.
    """
    import random

    dp_metrics = {}
    scale = sensitivity / epsilon

    # Metrics to protect (contain individual bid information)
    protected_keys = {
        "avg_surplus_ratio", "overbidding_indicator",
        "gini_coefficient", "weight_price_correlation",
        "theil_index", "atkinson_index",
    }

    for key, value in metrics.items():
        if key in protected_keys and isinstance(value, (int, float)):
            # Laplace noise: noise = -scale * sign(u) * ln(1 - 2|u|)
            u = random.uniform(-0.5, 0.5)
            noise = -scale * (1 if u >= 0 else -1) * math.log(1 - 2 * abs(u))
            dp_metrics[key] = value + noise
        else:
            dp_metrics[key] = value

    # Add privacy metadata
    dp_metrics["dp_epsilon"] = epsilon
    dp_metrics["dp_applied"] = True

    return dp_metrics
