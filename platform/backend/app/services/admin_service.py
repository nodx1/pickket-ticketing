"""Admin platform service — KPI, user/event/community management."""

import logging
import uuid
from datetime import datetime, timezone, timedelta

from sqlalchemy import String, select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.event import Event, EventStatus
from app.models.fanclub import Fanclub, FanclubMembership, MembershipStatus
from app.models.ticket import Ticket
from app.models.order import Order, OrderStatus
from app.models.audit_log import AuditLog
from app.models.organizer import OrganizerProfile, OrganizerStatus
from app.services.payment_service import PaymentService
from app.services.refund_service import RefundService

logger = logging.getLogger(__name__)


class AdminService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_platform_kpi(self) -> dict:
        now = datetime.now(timezone.utc)
        seven_days_ago = now - timedelta(days=7)

        total_users = (await self.session.execute(select(func.count(User.id)))).scalar() or 0

        total_organizers = (
            await self.session.execute(select(func.count(User.id)).where(User.is_organizer == True))
        ).scalar() or 0

        total_events = (await self.session.execute(select(func.count(Event.id)))).scalar() or 0

        active_events = (
            await self.session.execute(
                select(func.count(Event.id)).where(
                    Event.status.in_([EventStatus.BIDDING_OPEN, EventStatus.DRAFT])
                )
            )
        ).scalar() or 0

        total_communities = (
            await self.session.execute(select(func.count(Fanclub.id)))
        ).scalar() or 0

        total_tickets = (await self.session.execute(select(func.count(Ticket.id)))).scalar() or 0

        new_users_7d = (
            await self.session.execute(
                select(func.count(User.id)).where(User.created_at >= seven_days_ago)
            )
        ).scalar() or 0

        new_events_7d = (
            await self.session.execute(
                select(func.count(Event.id)).where(Event.created_at >= seven_days_ago)
            )
        ).scalar() or 0

        return {
            "total_users": total_users,
            "total_organizers": total_organizers,
            "total_events": total_events,
            "active_events": active_events,
            "total_communities": total_communities,
            "total_tickets": total_tickets,
            "new_users_7d": new_users_7d,
            "new_events_7d": new_events_7d,
        }

    async def search_users(
        self,
        q: str | None = None,
        is_organizer: bool | None = None,
        is_active: bool | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[User], int]:
        query = select(User)
        count_query = select(func.count(User.id))

        if q:
            pattern = f"%{q}%"
            filt = or_(User.email.ilike(pattern), User.name.ilike(pattern))
            query = query.where(filt)
            count_query = count_query.where(filt)
        if is_organizer is not None:
            query = query.where(User.is_organizer == is_organizer)
            count_query = count_query.where(User.is_organizer == is_organizer)
        if is_active is not None:
            query = query.where(User.is_active == is_active)
            count_query = count_query.where(User.is_active == is_active)

        total = (await self.session.execute(count_query)).scalar() or 0
        result = await self.session.execute(
            query.order_by(User.created_at.desc()).offset(skip).limit(limit)
        )
        return list(result.scalars().all()), total

    async def list_all_events(
        self,
        status: str | None = None,
        category: str | None = None,
        skip: int = 0,
        limit: int = 50,
        q: str | None = None,
    ) -> tuple[list[Event], int]:
        query = select(Event)
        count_query = select(func.count(Event.id))

        if q:
            filt = Event.title.ilike(f"%{q}%")
            query = query.where(filt)
            count_query = count_query.where(filt)
        if status:
            from sqlalchemy import cast, String as SAString
            status_val = status.lower()
            query = query.where(cast(Event.status, SAString) == status_val)
            count_query = count_query.where(cast(Event.status, SAString) == status_val)
        if category:
            query = query.where(Event.category == category)
            count_query = count_query.where(Event.category == category)

        total = (await self.session.execute(count_query)).scalar() or 0
        result = await self.session.execute(
            query.order_by(Event.created_at.desc()).offset(skip).limit(limit)
        )
        return list(result.scalars().all()), total

    async def list_communities(
        self,
        is_official: bool | None = None,
        skip: int = 0,
        limit: int = 50,
        q: str | None = None,
        community_type: str | None = None,
    ) -> tuple[list[dict], int]:
        query = select(Fanclub)
        count_query = select(func.count(Fanclub.id))

        if q:
            pattern = f"%{q}%"
            filt = or_(
                Fanclub.name.ilike(pattern),
                Fanclub.artist_name.ilike(pattern),
                Fanclub.subject_name.ilike(pattern),
            )
            query = query.where(filt)
            count_query = count_query.where(filt)
        if community_type:
            query = query.where(Fanclub.community_type == community_type)
            count_query = count_query.where(Fanclub.community_type == community_type)
        if is_official is not None:
            query = query.where(Fanclub.is_official == is_official)
            count_query = count_query.where(Fanclub.is_official == is_official)

        total = (await self.session.execute(count_query)).scalar() or 0

        # 커뮤니티 목록 + 멤버 수를 단일 쿼리로 조회 (N+1 제거)
        member_count_subq = (
            select(
                FanclubMembership.fanclub_id,
                func.count(FanclubMembership.id).label("member_count"),
            )
            .where(FanclubMembership.status == MembershipStatus.ACTIVE.value)
            .group_by(FanclubMembership.fanclub_id)
            .subquery()
        )

        joined_query = (
            query
            .outerjoin(member_count_subq, Fanclub.id == member_count_subq.c.fanclub_id)
            .add_columns(func.coalesce(member_count_subq.c.member_count, 0).label("mc"))
            .order_by(Fanclub.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        result = await self.session.execute(joined_query)
        communities = []
        for fc, mc in result.all():
            communities.append(
                {
                    "id": fc.id,
                    "name": fc.name,
                    "artist_name": fc.artist_name,
                    "subject_name": fc.subject_name,
                    "community_type": fc.community_type,
                    "domain": fc.domain,
                    "organizer_id": fc.organizer_id,
                    "member_count": mc,
                    "is_official": fc.is_official,
                    "is_active": fc.is_active,
                    "created_at": fc.created_at,
                }
            )
        return communities, total

    async def get_audit_log(
        self,
        event_id: str | None = None,
        action: str | None = None,
        skip: int = 0,
        limit: int = 50,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> tuple[list[AuditLog], int]:
        """WP-16: AuditLog 통합 모델에서 감사 로그 조회."""
        query = select(AuditLog)
        count_query = select(func.count(AuditLog.id))

        if event_id:
            query = query.where(AuditLog.event_id == event_id)
            count_query = count_query.where(AuditLog.event_id == event_id)
        if action:
            query = query.where(AuditLog.action == action)
            count_query = count_query.where(AuditLog.action == action)
        if date_from:
            parsed_from = datetime.strptime(date_from, "%Y-%m-%d")
            query = query.where(AuditLog.created_at >= parsed_from)
            count_query = count_query.where(AuditLog.created_at >= parsed_from)
        if date_to:
            parsed_to = datetime.strptime(date_to, "%Y-%m-%d") + timedelta(days=1)
            query = query.where(AuditLog.created_at <= parsed_to)
            count_query = count_query.where(AuditLog.created_at <= parsed_to)

        total = (await self.session.execute(count_query)).scalar() or 0
        result = await self.session.execute(
            query.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit)
        )
        return list(result.scalars().all()), total

    # ── CS: user orders / tickets ─────────────────────────────────

    async def get_user_orders(
        self,
        user_id: "uuid.UUID",
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict], int]:
        """Get orders for a specific user (admin CS lookup)."""

        base = (
            select(Order, User.email, User.name, Event.title)
            .join(User, Order.user_id == User.id)
            .join(Event, Order.event_id == Event.id)
            .where(Order.user_id == user_id)
        )

        count_query = select(func.count(Order.id)).where(Order.user_id == user_id)
        total = (await self.session.execute(count_query)).scalar() or 0

        result = await self.session.execute(
            base.order_by(Order.created_at.desc()).offset(skip).limit(limit)
        )
        rows = result.all()
        orders = []
        for order, email, uname, etitle in rows:
            orders.append(
                {
                    "id": order.id,
                    "user_id": order.user_id,
                    "user_email": email,
                    "user_name": uname,
                    "event_id": order.event_id,
                    "event_title": etitle,
                    "order_type": order.order_type.value
                    if hasattr(order.order_type, "value")
                    else str(order.order_type),
                    "status": order.status.value
                    if hasattr(order.status, "value")
                    else str(order.status),
                    "quantity": order.quantity,
                    "total_amount": float(order.total_amount),
                    "payment_id": order.payment_id,
                    "pg_transaction_id": order.pg_transaction_id,
                    "created_at": order.created_at,
                }
            )
        return orders, total

    async def get_user_tickets(
        self,
        user_id: "uuid.UUID",
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict], int]:
        """Get tickets for a specific user (admin CS lookup)."""
        base = (
            select(Ticket, Event.title)
            .join(Event, Ticket.event_id == Event.id)
            .where(Ticket.current_owner_id == user_id)
        )

        count_query = select(func.count(Ticket.id)).where(Ticket.current_owner_id == user_id)
        total = (await self.session.execute(count_query)).scalar() or 0

        result = await self.session.execute(
            base.order_by(Ticket.created_at.desc()).offset(skip).limit(limit)
        )
        rows = result.all()
        tickets = []
        for ticket, etitle in rows:
            tickets.append(
                {
                    "id": ticket.id,
                    "event_id": ticket.event_id,
                    "event_title": etitle,
                    "tier_id": ticket.tier_id,
                    "status": ticket.status.value
                    if hasattr(ticket.status, "value")
                    else str(ticket.status),
                    "purchase_price": float(ticket.purchase_price),
                    "sale_mode": ticket.sale_mode,
                    "created_at": ticket.created_at,
                }
            )
        return tickets, total

    # ── Global order search ───────────────────────────────────────

    async def search_orders(
        self,
        q: str | None = None,
        status: str | None = None,
        event_id: "uuid.UUID | None" = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict], int]:
        """Global order search for admin."""
        base = (
            select(Order, User.email, User.name, Event.title)
            .join(User, Order.user_id == User.id)
            .join(Event, Order.event_id == Event.id)
        )
        count_base = (
            select(func.count(Order.id))
            .join(User, Order.user_id == User.id)
            .join(Event, Order.event_id == Event.id)
        )

        if q:
            pattern = f"%{q}%"
            filt = or_(
                Order.id.cast(String).ilike(pattern),
                User.email.ilike(pattern),
                Event.title.ilike(pattern),
            )
            base = base.where(filt)
            count_base = count_base.where(filt)
        if status:
            base = base.where(Order.status == status)
            count_base = count_base.where(Order.status == status)
        if event_id:
            base = base.where(Order.event_id == event_id)
            count_base = count_base.where(Order.event_id == event_id)
        if date_from:
            base = base.where(Order.created_at >= date_from)
            count_base = count_base.where(Order.created_at >= date_from)
        if date_to:
            base = base.where(Order.created_at <= date_to)
            count_base = count_base.where(Order.created_at <= date_to)

        total = (await self.session.execute(count_base)).scalar() or 0
        result = await self.session.execute(
            base.order_by(Order.created_at.desc()).offset(skip).limit(limit)
        )
        rows = result.all()
        orders = []
        for order, email, uname, etitle in rows:
            orders.append(
                {
                    "id": order.id,
                    "user_id": order.user_id,
                    "user_email": email,
                    "user_name": uname,
                    "event_id": order.event_id,
                    "event_title": etitle,
                    "order_type": order.order_type.value
                    if hasattr(order.order_type, "value")
                    else str(order.order_type),
                    "status": order.status.value
                    if hasattr(order.status, "value")
                    else str(order.status),
                    "quantity": order.quantity,
                    "total_amount": float(order.total_amount),
                    "payment_id": order.payment_id,
                    "pg_transaction_id": order.pg_transaction_id,
                    "created_at": order.created_at,
                }
            )
        return orders, total

    # ── Bulk operations ───────────────────────────────────────────

    async def bulk_ban_users(self, user_ids: list, reason: str = "") -> dict:
        """Ban multiple users at once."""
        result = await self.session.execute(
            select(User).where(User.id.in_(user_ids), User.is_active == True)
        )
        users = list(result.scalars().all())
        success = 0
        for u in users:
            u.is_active = False
            success += 1
        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        for u in users:
            await invalidate_user_cache(u.id)
        await self.session.commit()
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        for u in users:
            await invalidate_user_cache(u.id)
        return {
            "success_count": success,
            "failed_count": len(user_ids) - success,
            "detail": f"Banned {success} users" + (f" (reason: {reason})" if reason else ""),
        }

    async def bulk_unban_users(self, user_ids: list) -> dict:
        """Unban multiple users at once."""
        result = await self.session.execute(
            select(User).where(User.id.in_(user_ids), User.is_active == False)
        )
        users = list(result.scalars().all())
        success = 0
        for u in users:
            u.is_active = True
            success += 1
        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        for u in users:
            await invalidate_user_cache(u.id)
        await self.session.commit()
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        for u in users:
            await invalidate_user_cache(u.id)
        return {
            "success_count": success,
            "failed_count": len(user_ids) - success,
            "detail": f"Unbanned {success} users",
        }

    async def bulk_cancel_events(self, event_ids: list, reason: str = "") -> dict:
        """Cancel multiple events at once."""
        result = await self.session.execute(
            select(Event).where(
                Event.id.in_(event_ids),
                Event.status != EventStatus.CANCELLED,
            )
        )
        events = list(result.scalars().all())
        success = 0
        for e in events:
            e.status = EventStatus.CANCELLED
            success += 1
        await self.session.commit()
        return {
            "success_count": success,
            "failed_count": len(event_ids) - success,
            "detail": f"Cancelled {success} events" + (f" (reason: {reason})" if reason else ""),
        }

    async def bulk_feature_events(self, event_ids: list, featured: bool = True) -> dict:
        """Set featured status for multiple events."""
        result = await self.session.execute(select(Event).where(Event.id.in_(event_ids)))
        events = list(result.scalars().all())
        success = 0
        for e in events:
            e.is_featured = featured
            success += 1
        await self.session.commit()
        return {
            "success_count": success,
            "failed_count": len(event_ids) - success,
            "detail": f"Set featured={featured} for {success} events",
        }

    async def bulk_review_events(
        self, event_ids: list, action: str, comment: str = "", reviewer_id=None
    ) -> dict:
        """Review multiple events at once (approve/reject/revision_requested)."""
        status_map = {
            "approve": EventStatus.APPROVED,
            "reject": EventStatus.CANCELLED,
            "revision_requested": EventStatus.REVISION_REQUESTED,
        }
        target_status = status_map.get(action)
        if not target_status:
            return {
                "success_count": 0,
                "failed_count": len(event_ids),
                "detail": f"Unknown action: {action}",
            }

        result = await self.session.execute(
            select(Event).where(
                Event.id.in_(event_ids),
                Event.status.in_([EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW]),
            )
        )
        events = list(result.scalars().all())
        success = 0
        approved_event_ids = []
        reviewed_ids = [e.id for e in events]  # 커밋 후 만료 대비 사전 캡처(go 통보용)
        for e in events:
            e.status = target_status
            if target_status == EventStatus.APPROVED:
                approved_event_ids.append(e.id)
            success += 1
        await self.session.commit()

        # 캐시 invalidate — 승인된 이벤트가 홈/목록에 즉시 반영되도록
        # (events:featured, events:trending, events:list:*, events:search:* 등 flush)
        try:
            from app.api.v1.events import _invalidate_event_caches
            for eid in approved_event_ids:
                await _invalidate_event_caches(eid)
            if approved_event_ids and not events:
                # 개별 이벤트 key 없어도 목록 캐시는 flush
                await _invalidate_event_caches(None)
        except Exception:
            pass

        # go 로 심사 결과 통보 (approve/reject) — 단건 리뷰 경로(events.py)와 동일 계약.
        # 누락 시 go 이벤트가 pending_review 에 멈춰 go 마켓(/#events)에 노출되지 않는다.
        if action in ("approve", "reject") and reviewed_ids:
            from app.services.go_review_webhook import send_review_result

            go_action = "approved" if action == "approve" else "rejected"
            for eid in reviewed_ids:
                try:
                    await send_review_result(
                        event_id=eid,
                        action=go_action,
                        reviewer_id=reviewer_id,
                        reason=comment,
                    )
                except Exception:
                    logger.warning("bulk_review_events: go 통보 실패 event=%s", eid)

        return {
            "success_count": success,
            "failed_count": len(event_ids) - success,
            "detail": f"Reviewed {success} events with action={action}"
            + (f" ({comment})" if comment else ""),
        }

    async def bulk_approve_organizers(self, profile_ids: list) -> dict:
        """Approve multiple organizer profiles."""
        result = await self.session.execute(
            select(OrganizerProfile).where(
                OrganizerProfile.id.in_(profile_ids),
                OrganizerProfile.status == OrganizerStatus.PENDING,
            )
        )
        profiles = list(result.scalars().all())
        success = 0
        now = datetime.now(timezone.utc)
        for p in profiles:
            p.status = OrganizerStatus.APPROVED
            p.approved_at = now
            # Also promote the user to organizer role
            user_result = await self.session.execute(select(User).where(User.id == p.user_id))
            user = user_result.scalar_one_or_none()
            if user:
                user.is_organizer = True
            success += 1
        # P0-12: Invalidate cache BEFORE commit to close race window
        from app.core.redis import invalidate_user_cache
        for p in profiles:
            await invalidate_user_cache(p.user_id)
        await self.session.commit()
        # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
        for p in profiles:
            await invalidate_user_cache(p.user_id)
        return {
            "success_count": success,
            "failed_count": len(profile_ids) - success,
            "detail": f"Approved {success} organizer profiles",
        }

    async def bulk_reject_organizers(self, profile_ids: list, reason: str = "") -> dict:
        """Reject multiple organizer profiles."""
        result = await self.session.execute(
            select(OrganizerProfile).where(
                OrganizerProfile.id.in_(profile_ids),
                OrganizerProfile.status == OrganizerStatus.PENDING,
            )
        )
        profiles = list(result.scalars().all())
        success = 0
        for p in profiles:
            p.status = OrganizerStatus.REJECTED
            p.rejection_reason = reason
            success += 1
        await self.session.commit()
        return {
            "success_count": success,
            "failed_count": len(profile_ids) - success,
            "detail": f"Rejected {success} organizer profiles"
            + (f" (reason: {reason})" if reason else ""),
        }

    # ── Custom Reports ─────────────────────────────────────────────

    async def generate_report(
        self,
        report_type: str,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict:
        """Generate a custom report by type with date filtering."""
        now = datetime.now(timezone.utc)

        # Parse date filters
        d_from = (
            datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if date_from
            else now - timedelta(days=30)
        )
        d_to = (
            datetime.strptime(date_to, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
            if date_to
            else now
        )

        if report_type == "sales_summary":
            return await self._report_sales_summary(d_from, d_to)
        elif report_type == "user_growth":
            return await self._report_user_growth(d_from, d_to)
        elif report_type == "event_performance":
            return await self._report_event_performance(d_from, d_to)
        elif report_type == "refund_analysis":
            return await self._report_refund_analysis(d_from, d_to)
        else:
            return {"data": [], "summary": {"error": f"Unknown report type: {report_type}"}}

    async def _report_sales_summary(self, d_from: datetime, d_to: datetime) -> dict:
        """Sales summary report: daily revenue and order counts."""
        from sqlalchemy import cast, Date

        rows = (
            await self.session.execute(
                select(
                    cast(Order.created_at, Date).label("date"),
                    func.count(Order.id).label("order_count"),
                    func.coalesce(func.sum(Order.total_amount), 0.0).label("revenue"),
                    func.coalesce(func.sum(Order.quantity), 0).label("tickets"),
                )
                .where(
                    Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                    Order.created_at >= d_from,
                    Order.created_at <= d_to,
                )
                .group_by(cast(Order.created_at, Date))
                .order_by(cast(Order.created_at, Date))
            )
        ).all()

        data = [
            {
                "date": str(row.date),
                "order_count": int(row.order_count),
                "revenue": float(row.revenue),
                "tickets": int(row.tickets),
            }
            for row in rows
        ]

        total_revenue = sum(d["revenue"] for d in data)
        total_orders = sum(d["order_count"] for d in data)
        total_tickets = sum(d["tickets"] for d in data)

        return {
            "data": data,
            "summary": {
                "total_revenue": round(total_revenue, 2),
                "total_orders": total_orders,
                "total_tickets": total_tickets,
                "avg_order_value": round(total_revenue / total_orders, 2) if total_orders else 0,
            },
        }

    async def _report_user_growth(self, d_from: datetime, d_to: datetime) -> dict:
        """User growth report: daily signups."""
        from sqlalchemy import cast, Date

        rows = (
            await self.session.execute(
                select(
                    cast(User.created_at, Date).label("date"),
                    func.count(User.id).label("signups"),
                    func.count(User.id)
                    .filter(User.is_organizer == True)
                    .label("organizer_signups"),
                )
                .where(
                    User.created_at >= d_from,
                    User.created_at <= d_to,
                )
                .group_by(cast(User.created_at, Date))
                .order_by(cast(User.created_at, Date))
            )
        ).all()

        data = [
            {
                "date": str(row.date),
                "signups": int(row.signups),
                "organizer_signups": int(row.organizer_signups),
            }
            for row in rows
        ]

        total_signups = sum(d["signups"] for d in data)
        total_organizer_signups = sum(d["organizer_signups"] for d in data)

        return {
            "data": data,
            "summary": {
                "total_signups": total_signups,
                "total_organizer_signups": total_organizer_signups,
                "avg_daily_signups": round(total_signups / max(len(data), 1), 2),
            },
        }

    async def _report_event_performance(self, d_from: datetime, d_to: datetime) -> dict:
        """Event performance report: events with revenue and ticket stats."""
        revenue_sq = (
            select(
                Order.event_id.label("event_id"),
                func.coalesce(func.sum(Order.total_amount), 0.0).label("revenue"),
                func.coalesce(func.sum(Order.quantity), 0).label("tickets_sold"),
                func.count(Order.id).label("order_count"),
            )
            .where(Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]))
            .group_by(Order.event_id)
            .subquery()
        )

        rows = (
            await self.session.execute(
                select(
                    Event.id,
                    Event.title,
                    Event.category,
                    Event.total_seats,
                    Event.status,
                    Event.event_date,
                    func.coalesce(revenue_sq.c.revenue, 0.0).label("revenue"),
                    func.coalesce(revenue_sq.c.tickets_sold, 0).label("tickets_sold"),
                    func.coalesce(revenue_sq.c.order_count, 0).label("order_count"),
                )
                .outerjoin(revenue_sq, revenue_sq.c.event_id == Event.id)
                .where(
                    Event.created_at >= d_from,
                    Event.created_at <= d_to,
                )
                .order_by(func.coalesce(revenue_sq.c.revenue, 0.0).desc())
            )
        ).all()

        data = [
            {
                "event_id": str(row.id),
                "title": row.title,
                "category": row.category,
                "total_seats": int(row.total_seats),
                "status": row.status.value if hasattr(row.status, "value") else str(row.status),
                "event_date": str(row.event_date),
                "revenue": float(row.revenue),
                "tickets_sold": int(row.tickets_sold),
                "order_count": int(row.order_count),
                "fill_rate": round(int(row.tickets_sold) / max(int(row.total_seats), 1) * 100, 1),
            }
            for row in rows
        ]

        total_revenue = sum(d["revenue"] for d in data)
        total_tickets = sum(d["tickets_sold"] for d in data)

        return {
            "data": data,
            "summary": {
                "total_events": len(data),
                "total_revenue": round(total_revenue, 2),
                "total_tickets_sold": total_tickets,
                "avg_fill_rate": round(sum(d["fill_rate"] for d in data) / max(len(data), 1), 1),
            },
        }

    async def _report_refund_analysis(self, d_from: datetime, d_to: datetime) -> dict:
        """Refund analysis report: daily refunds and reasons."""
        from sqlalchemy import cast, Date

        rows = (
            await self.session.execute(
                select(
                    cast(Order.updated_at, Date).label("date"),
                    func.count(Order.id).label("refund_count"),
                    func.coalesce(func.sum(Order.total_amount), 0.0).label("refund_amount"),
                )
                .where(
                    Order.status == OrderStatus.REFUNDED,
                    Order.updated_at >= d_from,
                    Order.updated_at <= d_to,
                )
                .group_by(cast(Order.updated_at, Date))
                .order_by(cast(Order.updated_at, Date))
            )
        ).all()

        data = [
            {
                "date": str(row.date),
                "refund_count": int(row.refund_count),
                "refund_amount": float(row.refund_amount),
            }
            for row in rows
        ]

        total_refund_count = sum(d["refund_count"] for d in data)
        total_refund_amount = sum(d["refund_amount"] for d in data)

        # Get total confirmed orders in the same period for refund rate
        total_confirmed = (
            await self.session.execute(
                select(func.count(Order.id)).where(
                    Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                    Order.created_at >= d_from,
                    Order.created_at <= d_to,
                )
            )
        ).scalar() or 0

        return {
            "data": data,
            "summary": {
                "total_refund_count": total_refund_count,
                "total_refund_amount": round(total_refund_amount, 2),
                "refund_rate": round(
                    total_refund_count / max(total_confirmed + total_refund_count, 1) * 100, 2
                ),
                "avg_refund_amount": round(total_refund_amount / max(total_refund_count, 1), 2),
            },
        }

    async def bulk_refund_orders(self, order_ids: list, reason: str = "") -> dict:
        """Process refund/cancellation for multiple orders with payment-service invariants."""
        refundable = [OrderStatus.PAID, OrderStatus.CONFIRMED]
        result = await self.session.execute(
            select(Order).where(
                Order.id.in_(order_ids),
            )
        )
        orders = list(result.scalars().all())
        success = 0
        failures: list[dict] = []
        payment_service = PaymentService(self.session)
        refund_service = RefundService(self.session)
        reason_text = reason or "admin_bulk_refund"

        for o in orders:
            try:
                if o.status in refundable:
                    await refund_service.request_refund(
                        o.id,
                        reason=reason_text,
                        initiated_by="admin",
                        force_auto_approve=True,
                    )
                    success += 1
                elif o.status in (
                    OrderStatus.PENDING,
                    OrderStatus.PAYMENT_REQUIRED,
                    OrderStatus.AUTHORIZED,
                ):
                    await payment_service.cancel_order(o.id, target_status=OrderStatus.CANCELLED)
                    success += 1
                elif o.status in (OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REFUNDED):
                    # Idempotent bulk actions should not fail on terminal states.
                    success += 1
                else:
                    failures.append(
                        {
                            "order_id": str(o.id),
                            "reason": f"Unsupported order status: {o.status.value}",
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Bulk refund/cancel failed for order %s", o.id, exc_info=True)
                failures.append({"order_id": str(o.id), "reason": str(exc)})
        await self.session.commit()
        return {
            "success_count": success,
            "failed_count": len(order_ids) - success,
            "detail": (
                f"Processed {success} orders"
                + (f", failures: {len(failures)}" if failures else "")
                + (f" (reason: {reason})" if reason else "")
            ),
        }
