"""
Organizer Dashboard Tests
===========================
Tests for the RISE dashboard service: tier sales tracking,
event aggregation, revenue estimation, and mode comparison.
"""

import pytest
from talkfile_engine.dashboard import (
    TierStatus,
    EventDashboard,
    DashboardService,
)


@pytest.fixture
def svc():
    """Fresh DashboardService for each test."""
    return DashboardService()


class TestUpdateTierSales:
    """Tests for DashboardService.update_tier_sales()."""

    def test_creates_tier_status(self, svc):
        """update_tier_sales() returns a correctly populated TierStatus."""
        status = svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=100,
            sold_seats=60, prices=[80_000, 90_000, 70_000],
            total_applicants=200, waitlist_size=10,
        )

        assert isinstance(status, TierStatus)
        assert status.tier_id == "t1"
        assert status.tier_name == "VIP"
        assert status.sale_mode == "point_lottery"
        assert status.total_seats == 100
        assert status.sold_seats == 60
        assert status.remaining_seats == 40
        assert status.total_revenue == 240_000  # sum of prices
        assert status.avg_price == 80_000.0     # mean of prices
        assert status.competition_ratio == 2.0  # 200/100
        assert status.waitlist_size == 10

    def test_no_prices_yields_zero_revenue(self, svc):
        """When prices is None, revenue and avg_price are 0."""
        status = svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="GA",
            sale_mode="fcfs", total_seats=50, sold_seats=0,
        )
        assert status.total_revenue == 0.0
        assert status.avg_price == 0.0

    def test_zero_seats_competition_ratio(self, svc):
        """Zero total_seats avoids division-by-zero in competition_ratio."""
        status = svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="X",
            sale_mode="fcfs", total_seats=0, sold_seats=0,
            total_applicants=10,
        )
        assert status.competition_ratio == 0.0


class TestGetEventDashboard:
    """Tests for get_event_dashboard() aggregation."""

    def test_aggregates_multiple_tiers(self, svc):
        """Dashboard totals are the sum across all tiers for the event."""
        svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=100,
            sold_seats=60, prices=[80_000, 90_000, 70_000],
        )
        svc.update_tier_sales(
            event_id="e1", tier_id="t2", tier_name="GA",
            sale_mode="fcfs", total_seats=200,
            sold_seats=150, prices=[50_000] * 150,
        )

        dashboard = svc.get_event_dashboard("e1", "Test Event", "allocation")

        assert isinstance(dashboard, EventDashboard)
        assert len(dashboard.tier_statuses) == 2
        assert dashboard.total_sold == 60 + 150
        assert dashboard.total_remaining == 40 + 50
        expected_revenue = 240_000 + 7_500_000
        assert dashboard.total_revenue == expected_revenue

    def test_excludes_other_events(self, svc):
        """Only tiers belonging to the requested event are included."""
        svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=100,
            sold_seats=10, prices=[80_000] * 10,
        )
        svc.update_tier_sales(
            event_id="e2", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=50,
            sold_seats=5, prices=[90_000] * 5,
        )

        dashboard = svc.get_event_dashboard("e1", "Event One", "open")
        assert len(dashboard.tier_statuses) == 1
        assert dashboard.total_sold == 10

    def test_empty_event_dashboard(self, svc):
        """Dashboard for an event with no tier data returns zeroes."""
        dashboard = svc.get_event_dashboard("e_none", "Empty", "draft")
        assert dashboard.total_revenue == 0.0
        assert dashboard.total_sold == 0
        assert dashboard.total_remaining == 0
        assert len(dashboard.tier_statuses) == 0

    def test_vcg_metrics_integration(self, svc):
        """VCG behavioral metrics are attached when provided."""
        svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=100,
            sold_seats=50, prices=[80_000] * 50,
        )

        vcg = {
            "gini_coefficient": 0.35,
            "overbidding_indicator": 0.12,
            "total_consumer_surplus": 500_000.0,
        }
        dashboard = svc.get_event_dashboard("e1", "Show", "completed", vcg_metrics=vcg)

        assert dashboard.vcg_gini == 0.35
        assert dashboard.vcg_overbidding == 0.12
        assert dashboard.vcg_surplus == 500_000.0

    def test_vcg_metrics_none_by_default(self, svc):
        """Without vcg_metrics, VCG fields remain None."""
        dashboard = svc.get_event_dashboard("e1", "Show", "open")
        assert dashboard.vcg_gini is None
        assert dashboard.vcg_overbidding is None
        assert dashboard.vcg_surplus is None


class TestEstimateRevenue:
    """Tests for estimate_revenue() across sale modes."""

    def test_point_lottery_revenue_estimate(self, svc):
        """Point lottery estimate scales with competition ratio."""
        tiers = [{
            "tier_id": "t1",
            "sale_mode": "point_lottery",
            "total_seats": 100,
            "face_price": 80_000,
            "expected_competition_ratio": 0.8,
        }]
        result = svc.estimate_revenue(tiers)
        # fill_rate = min(1.0, 0.8) = 0.8
        expected = 100 * 80_000 * 0.8
        assert result["total_estimate"] == expected
        assert result["optimistic"] > result["total_estimate"]
        assert result["pessimistic"] < result["total_estimate"]
        assert len(result["by_tier"]) == 1

    def test_fcfs_revenue_estimate(self, svc):
        """Fixed-price mode uses fill rate from competition ratio."""
        tiers = [{
            "tier_id": "t1",
            "sale_mode": "fcfs",
            "total_seats": 100,
            "face_price": 50_000,
            "expected_competition_ratio": 0.8,
        }]
        result = svc.estimate_revenue(tiers)
        # fill_rate = min(1.0, 0.8) = 0.8
        expected = 100 * 50_000 * 0.8
        assert result["total_estimate"] == expected

    def test_empty_tiers(self, svc):
        """Empty tier list yields zero estimates."""
        result = svc.estimate_revenue([])
        assert result["total_estimate"] == 0.0
        assert result["optimistic"] == 0.0
        assert result["pessimistic"] == 0.0
        assert result["by_tier"] == []


class TestCompareModes:
    """Tests for compare_modes() actual vs FCFS comparison."""

    def test_actual_vs_fcfs_comparison(self, svc):
        """Comparison shows difference between actual revenue and hypothetical FCFS."""
        svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="VIP",
            sale_mode="point_lottery", total_seats=100,
            sold_seats=50,
            prices=[90_000] * 50,   # actual revenue = 4,500,000
        )

        face_prices = {"t1": 80_000}  # FCFS hypothetical = 50 * 80,000 = 4,000,000
        result = svc.compare_modes("e1", face_prices)

        assert result["event_id"] == "e1"
        assert result["total_vcg_revenue"] == 4_500_000
        assert result["total_fcfs_revenue"] == 4_000_000
        assert result["revenue_difference"] == 500_000
        assert result["revenue_ratio"] == pytest.approx(1.13, abs=0.01)
        assert len(result["by_tier"]) == 1

    def test_compare_modes_empty_event(self, svc):
        """Comparison on event with no data returns zeros."""
        result = svc.compare_modes("e_none")
        assert result["total_vcg_revenue"] == 0.0
        assert result["total_fcfs_revenue"] == 0.0
        assert result["revenue_difference"] == 0.0
        assert result["revenue_ratio"] == 0.0
        assert result["by_tier"] == []

    def test_compare_modes_no_face_price(self, svc):
        """Missing face_price defaults to 0 for FCFS hypothetical."""
        svc.update_tier_sales(
            event_id="e1", tier_id="t1", tier_name="GA",
            sale_mode="point_lottery", total_seats=50,
            sold_seats=20, prices=[60_000] * 20,
        )

        result = svc.compare_modes("e1")  # no face_prices provided

        assert result["total_vcg_revenue"] == 1_200_000
        assert result["total_fcfs_revenue"] == 0.0
        # ratio should be 0.0 because fcfs_revenue is 0 (division guard)
        assert result["revenue_ratio"] == 0.0
