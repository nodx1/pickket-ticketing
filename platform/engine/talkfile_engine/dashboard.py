"""
Pickket Organizer Dashboard
=============================
Analytics and monitoring for event organizers.

Features:
  - Per-tier status (sold, remaining, revenue, competition)
  - Revenue estimation and comparison
  - Multi-session trend analysis
"""

from dataclasses import dataclass, field
from statistics import mean, median


@dataclass
class TierStatus:
    """Status of a single tier."""
    tier_id: str
    tier_name: str
    sale_mode: str
    total_seats: int
    sold_seats: int = 0
    remaining_seats: int = 0
    total_revenue: float = 0.0
    avg_price: float = 0.0
    competition_ratio: float = 0.0
    waitlist_size: int = 0


@dataclass
class EventDashboard:
    """Complete event dashboard data."""
    event_id: str
    event_name: str
    current_phase: str
    tier_statuses: list[TierStatus] = field(default_factory=list)
    total_revenue: float = 0.0
    total_sold: int = 0
    total_remaining: int = 0
    # VCG-specific
    vcg_gini: float | None = None
    vcg_overbidding: float | None = None
    vcg_surplus: float | None = None
    # Comparison
    revenue_vs_all_fcfs: float | None = None


class DashboardService:
    """Service for generating dashboard data."""

    def __init__(self):
        self._tier_data: dict[str, dict] = {}  # event_id:tier_id -> data

    def update_tier_sales(
        self,
        event_id: str,
        tier_id: str,
        tier_name: str,
        sale_mode: str,
        total_seats: int,
        sold_seats: int,
        prices: list[float] | None = None,
        total_applicants: int = 0,
        waitlist_size: int = 0,
    ) -> TierStatus:
        """Update tier sales data and return current status."""
        key = f"{event_id}:{tier_id}"
        remaining = total_seats - sold_seats
        total_revenue = sum(prices) if prices else 0.0
        avg_price = mean(prices) if prices else 0.0
        competition = total_applicants / total_seats if total_seats > 0 else 0.0

        status = TierStatus(
            tier_id=tier_id,
            tier_name=tier_name,
            sale_mode=sale_mode,
            total_seats=total_seats,
            sold_seats=sold_seats,
            remaining_seats=remaining,
            total_revenue=total_revenue,
            avg_price=round(avg_price, 2),
            competition_ratio=round(competition, 2),
            waitlist_size=waitlist_size,
        )

        self._tier_data[key] = {
            "status": status,
            "prices": prices or [],
            "total_applicants": total_applicants,
        }
        return status

    def get_event_dashboard(
        self,
        event_id: str,
        event_name: str,
        current_phase: str,
        vcg_metrics: dict | None = None,
    ) -> EventDashboard:
        """Generate complete event dashboard."""
        tier_statuses: list[TierStatus] = []
        total_revenue = 0.0
        total_sold = 0
        total_remaining = 0

        for key, data in self._tier_data.items():
            if key.startswith(f"{event_id}:"):
                status = data["status"]
                tier_statuses.append(status)
                total_revenue += status.total_revenue
                total_sold += status.sold_seats
                total_remaining += status.remaining_seats

        dashboard = EventDashboard(
            event_id=event_id,
            event_name=event_name,
            current_phase=current_phase,
            tier_statuses=tier_statuses,
            total_revenue=round(total_revenue, 2),
            total_sold=total_sold,
            total_remaining=total_remaining,
        )

        if vcg_metrics:
            dashboard.vcg_gini = vcg_metrics.get("gini_coefficient")
            dashboard.vcg_overbidding = vcg_metrics.get("overbidding_indicator")
            dashboard.vcg_surplus = vcg_metrics.get("total_consumer_surplus")

        return dashboard

    def estimate_revenue(
        self,
        tiers: list[dict],
    ) -> dict:
        """
        Pre-sale revenue estimate.

        Args:
            tiers: list of {"tier_id", "sale_mode", "total_seats", "face_price",
                           "expected_competition_ratio"}
        Returns:
            {"total_estimate", "by_tier": [...], "optimistic", "pessimistic"}
        """
        by_tier = []
        total = 0.0
        optimistic = 0.0
        pessimistic = 0.0

        for t in tiers:
            seats = t["total_seats"]
            face = t["face_price"]
            mode = t["sale_mode"]
            ratio = t.get("expected_competition_ratio", 1.0)

            if mode == "point_lottery":
                # AP 공정배분: 정가 기반, 경쟁률에 따른 충원율 추정
                fill_rate = min(1.0, ratio) if ratio > 0 else 0.5
                estimate = seats * face * fill_rate
                opt = seats * face * min(1.0, fill_rate * 1.1)
                pess = seats * face * max(0.3, fill_rate * 0.8)
            else:
                # Fixed price modes (FCFS, fanclub): face_price × expected_fill_rate
                fill_rate = min(1.0, ratio) if ratio > 0 else 0.5
                estimate = seats * face * fill_rate
                opt = seats * face * min(1.0, fill_rate * 1.1)
                pess = seats * face * max(0.3, fill_rate * 0.8)

            by_tier.append({
                "tier_id": t["tier_id"],
                "sale_mode": mode,
                "estimate": round(estimate, 2),
                "optimistic": round(opt, 2),
                "pessimistic": round(pess, 2),
            })
            total += estimate
            optimistic += opt
            pessimistic += pess

        return {
            "total_estimate": round(total, 2),
            "optimistic": round(optimistic, 2),
            "pessimistic": round(pessimistic, 2),
            "by_tier": by_tier,
        }

    def compare_modes(
        self,
        event_id: str,
        face_prices: dict[str, float] | None = None,
    ) -> dict:
        """
        Compare actual VCG revenue vs hypothetical all-FCFS revenue.

        Args:
            event_id: Event to analyze
            face_prices: {tier_id: face_price} for FCFS comparison

        Returns:
            Comparison metrics
        """
        if not face_prices:
            face_prices = {}

        vcg_revenue = 0.0
        fcfs_revenue = 0.0
        comparisons = []

        for key, data in self._tier_data.items():
            if not key.startswith(f"{event_id}:"):
                continue
            status = data["status"]
            tier_id = status.tier_id
            face = face_prices.get(tier_id, 0.0)

            actual = status.total_revenue
            hypothetical_fcfs = status.sold_seats * face

            comparisons.append({
                "tier_id": tier_id,
                "sale_mode": status.sale_mode,
                "actual_revenue": actual,
                "hypothetical_fcfs": hypothetical_fcfs,
                "difference": round(actual - hypothetical_fcfs, 2),
                "ratio": round(actual / hypothetical_fcfs, 2) if hypothetical_fcfs > 0 else 0.0,
            })

            vcg_revenue += actual
            fcfs_revenue += hypothetical_fcfs

        return {
            "event_id": event_id,
            "total_vcg_revenue": round(vcg_revenue, 2),
            "total_fcfs_revenue": round(fcfs_revenue, 2),
            "revenue_difference": round(vcg_revenue - fcfs_revenue, 2),
            "revenue_ratio": round(vcg_revenue / fcfs_revenue, 2) if fcfs_revenue > 0 else 0.0,
            "by_tier": comparisons,
        }
