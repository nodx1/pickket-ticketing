"""
Dashboard Service
==================
Analytics and monitoring for event organizers.
Aggregates per-tier stats, revenue, and compliance data.
"""

import uuid
from datetime import timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.audit_log import AuditLog

from app.models.allocation import Allocation, AllocationStatus
from app.models.audit_log import AuditLog as AuditLogModel
from app.models.bid import Bid, BidStatus
from app.models.event import SeatTier
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.repositories.event_repo import EventRepository, SeatTierRepository
from app.repositories.waitlist_repo import WaitlistRepository
from app.schemas.dashboard import (
    ComplianceReportResponse,
    EventDashboardResponse,
    TierStatusResponse,
)


class DashboardService:
    """Service for generating organizer dashboard data."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.event_repo = EventRepository(session)
        self.tier_repo = SeatTierRepository(session)
        self.waitlist_repo = WaitlistRepository(session)

    async def get_event_dashboard(self, event_id: uuid.UUID) -> EventDashboardResponse:
        """
        Get complete dashboard data for an event.

        Aggregates per-tier sales, revenue, competition ratio,
        waitlist sizes, and 공정 배분 지표.

        Args:
            event_id: Event UUID.

        Returns:
            EventDashboardResponse with all dashboard data.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        tiers = await self.tier_repo.get_by_event(event_id)

        tier_statuses: list[TierStatusResponse] = []
        total_revenue = 0.0
        total_sold = 0
        total_remaining = 0

        for tier in tiers:
            # Compute revenue from confirmed orders for this tier
            revenue_result = await self.session.execute(
                select(func.coalesce(func.sum(Order.total_amount), 0.0)).where(
                    Order.event_id == event_id,
                    Order.tier_id == tier.id,
                    Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                )
            )
            tier_revenue = float(revenue_result.scalar() or 0.0)

            # Compute average price
            avg_result = await self.session.execute(
                select(func.coalesce(func.avg(Ticket.purchase_price), 0.0)).where(
                    Ticket.event_id == event_id,
                    Ticket.tier_id == tier.id,
                    Ticket.status == TicketStatus.ACTIVE,
                )
            )
            avg_price = float(avg_result.scalar() or 0.0)

            # Compute competition ratio (bids or applicants / seats)
            bid_count_result = await self.session.execute(
                select(func.count(Bid.id)).where(
                    Bid.event_id == event_id,
                    Bid.tier_id == tier.id,
                )
            )
            bid_count = int(bid_count_result.scalar() or 0)

            remaining = tier.capacity - tier.sold_count
            competition = bid_count / tier.capacity if tier.capacity > 0 else 0.0

            # Waitlist size
            waitlist_count = await self.waitlist_repo.count_waiting(tier.id)

            tier_statuses.append(
                TierStatusResponse(
                    tier_id=tier.id,
                    tier_name=tier.name,
                    sale_mode=tier.sale_mode,
                    total_seats=tier.capacity,
                    sold_seats=tier.sold_count,
                    remaining_seats=remaining,
                    total_revenue=round(tier_revenue, 2),
                    avg_price=round(avg_price, 2),
                    competition_ratio=round(competition, 2),
                    waitlist_size=waitlist_count,
                )
            )

            total_revenue += tier_revenue
            total_sold += tier.sold_count
            total_remaining += remaining

        # 공정 배분 지표 (allocation 테이블에서 조회)
        fair_gini = None
        fair_overbidding = None
        fair_surplus = None

        alloc_result = await self.session.execute(
            select(Allocation).where(
                Allocation.event_id == event_id,
                Allocation.status == AllocationStatus.COMPLETED,
            )
        )
        allocation = alloc_result.scalar_one_or_none()
        if allocation:
            fair_gini = allocation.gini_coefficient
            fair_overbidding = allocation.overbidding_indicator
            fair_surplus = allocation.total_consumer_surplus

        return EventDashboardResponse(
            event_id=event_id,
            event_name=event.title,
            current_phase=event.current_phase,
            tier_statuses=tier_statuses,
            total_revenue=round(total_revenue, 2),
            total_sold=total_sold,
            total_remaining=total_remaining,
            fair_gini=fair_gini,
            fair_overbidding=fair_overbidding,
            fair_surplus=fair_surplus,
        )

    async def get_compliance_report(self, event_id: uuid.UUID) -> ComplianceReportResponse:
        """
        Generate a compliance report for regulatory requirements.

        Counts audit entries, anomalies blocked, identity verification rate,
        and price cap violations.

        Args:
            event_id: Event UUID.

        Returns:
            ComplianceReportResponse with compliance data.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        # Count total transactions (audit logs — WP-16 통합)
        audit_count_result = await self.session.execute(
            select(func.count(AuditLogModel.id)).where(
                AuditLogModel.event_id == event_id,
            )
        )
        audit_count = int(audit_count_result.scalar() or 0)

        # Count anomalies blocked
        anomalies_result = await self.session.execute(
            select(func.count(Bid.id)).where(
                Bid.event_id == event_id,
                Bid.status == BidStatus.REJECTED,
            )
        )
        anomalies_blocked = int(anomalies_result.scalar() or 0)

        # Identity verification rate among ticket holders
        total_tickets_result = await self.session.execute(
            select(func.count(Ticket.id)).where(
                Ticket.event_id == event_id,
                Ticket.status == TicketStatus.ACTIVE,
            )
        )
        total_tickets = int(total_tickets_result.scalar() or 0)

        # Count verified owners
        if total_tickets > 0:
            verified_result = await self.session.execute(
                select(func.count(func.distinct(Ticket.current_owner_id)))
                .where(
                    Ticket.event_id == event_id,
                    Ticket.status == TicketStatus.ACTIVE,
                )
                .where(
                    Ticket.current_owner_id.in_(select(User.id).where(User.verification_level >= 2))
                )
            )
            verified_count = int(verified_result.scalar() or 0)

            total_owners_result = await self.session.execute(
                select(func.count(func.distinct(Ticket.current_owner_id))).where(
                    Ticket.event_id == event_id,
                    Ticket.status == TicketStatus.ACTIVE,
                )
            )
            total_owners = int(total_owners_result.scalar() or 0)
            identity_verified_pct = (
                (verified_count / total_owners * 100.0) if total_owners > 0 else 0.0
            )
        else:
            identity_verified_pct = 0.0

        # Price cap violations (tickets sold above max_price_cap)
        violations_result = await self.session.execute(
            select(func.count(Ticket.id))
            .join(SeatTier, Ticket.tier_id == SeatTier.id)
            .where(
                Ticket.event_id == event_id,
                Ticket.status == TicketStatus.ACTIVE,
                SeatTier.max_price_cap > 0,
                Ticket.purchase_price > SeatTier.max_price_cap,
            )
        )
        price_cap_violations = int(violations_result.scalar() or 0)

        # Also generate the engine compliance report with full transaction history
        engine_report = await self._build_engine_compliance_report(event_id)

        return ComplianceReportResponse(
            event_id=event_id,
            total_transactions=audit_count,
            anomalies_blocked=anomalies_blocked,
            identity_verified_pct=round(identity_verified_pct, 1),
            price_cap_violations=price_cap_violations,
            audit_entries_count=audit_count,
            engine_report=engine_report,
        )

    async def _build_engine_audit_log(self, event_id: uuid.UUID) -> AuditLog:
        """
        Build an engine AuditLog from DB audit_logs for an event.

        WP-16: AuditLogModel(audit_logs) 통합 모델에서 조회.
        Loads all audit entries from the database and populates the engine's
        in-memory AuditLog to enable engine-level report generation.
        """
        result = await self.session.execute(
            select(AuditLogModel)
            .where(
                AuditLogModel.event_id == event_id,
            )
            .order_by(AuditLogModel.created_at.asc())
        )
        db_entries = list(result.scalars().all())

        audit_log = AuditLog()
        for entry in db_entries:
            created_at = entry.created_at
            if created_at and created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)

            # WP-16: AuditLog 필드를 engine AuditLog 포맷으로 매핑
            details = entry.new_value or {}
            result_val = details.pop("result", "success") if isinstance(details, dict) else "success"

            audit_log.log(
                event_id=str(entry.event_id) if entry.event_id else "",
                action=entry.action,
                user_id=str(entry.actor_id) if entry.actor_id else "",
                tier_id=str(entry.tier_id) if entry.tier_id else "",
                sale_mode=entry.sale_mode or "",
                details=details,
                ip_hash=entry.ip_address or "",
                result=result_val,
            )

        return audit_log

    async def _build_engine_compliance_report(self, event_id: uuid.UUID) -> dict:
        """
        Generate engine compliance report with full transaction history.

        Returns the engine's compliance report dict including hashed user IDs,
        timestamps, and identity verification status.
        """
        audit_log = await self._build_engine_audit_log(event_id)
        return audit_log.generate_compliance_report(str(event_id))

    async def get_transparency_report(
        self, event_id: uuid.UUID, tier_id: uuid.UUID | None = None
    ) -> dict:
        """
        Generate a public transparency report (anonymized).

        Builds engine AuditLog from DB entries and calls
        generate_transparency_report() to produce anonymized public data
        including participant bands, total sold, and price statistics.

        Args:
            event_id: Event UUID.
            tier_id: Optional specific tier to report on. If None, reports
                     on all tiers combined.

        Returns:
            Dict with anonymized transparency data.

        Raises:
            ValueError: If event not found.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        audit_log = await self._build_engine_audit_log(event_id)

        if tier_id:
            return audit_log.generate_transparency_report(
                event_id=str(event_id),
                tier_id=str(tier_id),
            )

        # If no tier specified, generate for all tiers and combine
        tiers = await self.tier_repo.get_by_event(event_id)
        if not tiers:
            return {
                "event_id": str(event_id),
                "tiers": [],
            }

        tier_reports = []
        for tier in tiers:
            report = audit_log.generate_transparency_report(
                event_id=str(event_id),
                tier_id=str(tier.id),
            )
            report["tier_name"] = tier.name
            tier_reports.append(report)

        return {
            "event_id": str(event_id),
            "event_name": event.title,
            "tiers": tier_reports,
        }
