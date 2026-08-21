"""Admin API endpoints — platform management."""

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.audit import write_audit_log
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_admin, require_scope
from app.models.order import Order, OrderStatus
from app.models.user import User
from app.models.event import Event
from app.models.fanclub import Fanclub
from app.schemas.admin import (
    PlatformKPIResponse,
    AdminUserItem,
    AdminUserListResponse,
    AdminEventItem,
    AdminEventListResponse,
    AdminCommunityItem,
    AdminCommunityListResponse,
    UserRoleUpdate,
    UserBanAction,
    AuditEntryResponse,
    AuditLogResponse,
    AdminOrderItem,
    AdminOrderListResponse,
    AdminTicketItem,
    AdminTicketListResponse,
    FinanceSummaryResponse,
    FinanceByEventItem,
    FinanceByEventResponse,
    FinanceByOrganizerItem,
    FinanceByOrganizerResponse,
    BulkActionRequest,
    BulkEventReviewRequest,
    BulkActionResponse,
    AdminNotificationSend,
    AdminNotificationBroadcast,
    AdminNotificationHistoryItem,
    AdminNotificationHistoryResponse,
    AdminRoleUpdate,
    ReportRequest,
    ReportResponse,
)
from app.services.admin_service import AdminService
from app.services.finance_service import FinanceService
from app.services.notification_admin_service import NotificationAdminService
from app.services.payment_service import PaymentService
from app.services.refund_service import RefundError, RefundService
from app.middleware.admin_security import (
    alert_critical_admin_action,
    detect_rapid_admin_actions,
)

router = APIRouter()
logger = logging.getLogger(__name__)


class RefundDecisionRequest(BaseModel):
    reason: str | None = None


async def _cancel_event_orders_and_refund(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    reason: str,
) -> dict:
    payment_service = PaymentService(db)
    refund_service = RefundService(db)
    refunded = 0
    cancelled = 0
    failed = 0
    # Propagations collected across all per-order refunds; drained by caller
    # after db.commit(). Exposed via refund_service.propagations.

    # Process orders in bounded batches (keyset pagination by id) so an event
    # with tens of thousands of orders never loads them all into memory.
    BATCH_SIZE = 200
    last_id: uuid.UUID | None = None
    while True:
        batch_query = (
            select(Order)
            .where(Order.event_id == event_id)
            .order_by(Order.id)
            .limit(BATCH_SIZE)
        )
        if last_id is not None:
            batch_query = batch_query.where(Order.id > last_id)

        result = await db.execute(batch_query)
        orders = list(result.scalars().all())
        if not orders:
            break

        for order in orders:
            last_id = order.id
            try:
                # SAVEPOINT per order — isolate a flush failure so it can't poison
                # the session and abort the remaining batches (see events.py).
                async with db.begin_nested():
                    if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
                        await refund_service.request_refund(
                            order.id,
                            reason=reason,
                            initiated_by="admin",
                            force_auto_approve=True,
                        )
                        refunded += 1
                    elif order.status in (
                        OrderStatus.PENDING,
                        OrderStatus.PAYMENT_REQUIRED,
                        OrderStatus.AUTHORIZED,
                    ):
                        await payment_service.cancel_order(order.id, target_status=OrderStatus.CANCELLED)
                        cancelled += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                logger.warning(
                    "Admin event cancellation order handling failed (event=%s, order=%s): %s",
                    event_id,
                    order.id,
                    exc,
                )

        if len(orders) < BATCH_SIZE:
            break

    return {
        "refunded": refunded,
        "cancelled": cancelled,
        "failed": failed,
        "_propagations": refund_service.propagations,
    }


@router.get("/admin/kpi", response_model=PlatformKPIResponse)
async def get_platform_kpi(
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    svc = AdminService(db)
    return await svc.get_platform_kpi()


@router.get("/admin/users", response_model=AdminUserListResponse)
async def list_users(
    q: str | None = None,
    is_organizer: bool | None = None,
    is_active: bool | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    svc = AdminService(db)
    users, total = await svc.search_users(q, is_organizer, is_active, skip, limit)
    items = [
        AdminUserItem(
            id=u.id,
            email=u.email,
            name=u.name,
            is_organizer=u.is_organizer,
            is_admin=u.is_admin,
            is_active=u.is_active,
            is_verified=u.is_verified,
            verification_level=u.verification_level,
            abuse_score=u.abuse_score,
            admin_role=getattr(u, "admin_role", None) if u.is_admin else None,
            created_at=u.created_at,
        )
        for u in users
    ]
    return AdminUserListResponse(users=items, total=total)


@router.get("/admin/users/{user_id}", response_model=AdminUserItem)
async def get_user_detail(
    user_id: uuid.UUID,
    _admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    return AdminUserItem(
        id=u.id,
        email=u.email,
        name=u.name,
        is_organizer=u.is_organizer,
        is_admin=u.is_admin,
        is_active=u.is_active,
        is_verified=u.is_verified,
        verification_level=u.verification_level,
        abuse_score=u.abuse_score,
        admin_role=getattr(u, "admin_role", None) if u.is_admin else None,
        created_at=u.created_at,
    )


@router.patch("/admin/users/{user_id}/roles")
async def update_user_roles(
    user_id: uuid.UUID,
    data: UserRoleUpdate,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # is_admin 변경은 super_admin 전용
    if data.is_admin is not None and getattr(admin, "admin_role", None) != "super_admin":
        raise HTTPException(status_code=403, detail="Only super_admin can grant or revoke admin status")
    old_roles = {"is_organizer": target.is_organizer, "is_admin": target.is_admin}
    if data.is_organizer is not None:
        target.is_organizer = data.is_organizer
    if data.is_admin is not None:
        target.is_admin = data.is_admin
        if not data.is_admin:
            target.admin_role = "viewer"
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="user.role_change",
        resource_type="user",
        resource_id=str(user_id),
        old_value=old_roles,
        new_value={"is_organizer": target.is_organizer, "is_admin": target.is_admin},
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(user_id)

    # 위험 행위 알림
    await alert_critical_admin_action(
        action="admin.user.role_change",
        admin_id=admin.id,
        admin_email=admin.email,
        admin_role=getattr(admin, "admin_role", "unknown"),
        target=f"user:{user_id}",
        details={"old": old_roles, "new": {"is_organizer": target.is_organizer, "is_admin": target.is_admin}},
    )
    await detect_rapid_admin_actions(admin.id, "admin.user.role_change")

    return {"detail": "Roles updated", "user_id": str(user_id)}


@router.post("/admin/users/{user_id}/ban")
async def ban_user(
    user_id: uuid.UUID,
    data: UserBanAction,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target.is_active = False
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="user.ban",
        resource_type="user",
        resource_id=str(user_id),
        new_value={"reason": data.reason if hasattr(data, "reason") else None},
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(user_id)

    # 위험 행위 알림
    await alert_critical_admin_action(
        action="admin.user.ban",
        admin_id=admin.id,
        admin_email=admin.email,
        admin_role=getattr(admin, "admin_role", "unknown"),
        target=f"user:{user_id} ({target.email})",
    )
    await detect_rapid_admin_actions(admin.id, "admin.user.ban")

    return {"detail": "User banned", "user_id": str(user_id)}


@router.post("/admin/users/{user_id}/unban")
async def unban_user(
    user_id: uuid.UUID,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    target.is_active = True
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="user.unban",
        resource_type="user",
        resource_id=str(user_id),
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(user_id)
    return {"detail": "User unbanned", "user_id": str(user_id)}


@router.get("/admin/events", response_model=AdminEventListResponse)
async def list_events(
    q: str | None = None,
    status: str | None = None,
    category: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    svc = AdminService(db)
    events, total = await svc.list_all_events(status, category, skip, limit, q=q)
    items = [
        AdminEventItem(
            id=e.id,
            title=e.title,
            organizer_id=e.organizer_id,
            category=e.category,
            status=e.status.value if hasattr(e.status, "value") else str(e.status),
            total_seats=e.total_seats,
            bid_count=e.bid_count,
            is_featured=e.is_featured,
            event_date=e.event_date,
            created_at=e.created_at,
        )
        for e in events
    ]
    return AdminEventListResponse(events=items, total=total)


@router.post("/admin/events/{event_id}/feature")
async def toggle_event_featured(
    event_id: uuid.UUID,
    admin: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    old_featured = event.is_featured
    event.is_featured = not event.is_featured
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="event.toggle_featured",
        resource_type="event",
        resource_id=str(event_id),
        old_value={"is_featured": old_featured},
        new_value={"is_featured": event.is_featured},
    )
    await db.commit()
    return {
        "detail": f"Featured {'enabled' if event.is_featured else 'disabled'}",
        "is_featured": event.is_featured,
    }


@router.post("/admin/events/{event_id}/cancel")
async def admin_cancel_event(
    event_id: uuid.UUID,
    admin: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_db),
):
    from app.models.event import EventStatus

    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    event.status = EventStatus.CANCELLED
    order_summary = await _cancel_event_orders_and_refund(
        db,
        event_id=event_id,
        reason="event_cancelled_by_admin",
    )
    propagations = order_summary.pop("_propagations", [])
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="event.admin_cancel",
        resource_type="event",
        resource_id=str(event_id),
        new_value={"orders": order_summary},
    )
    await db.commit()

    # PR-U2: v2 → go propagation (order.refunded bulk), after commit
    from app.api.v1.orders import _drain_propagations
    _drain_propagations(propagations)

    # 취소 후 consumer 목록/검색/상세 캐시 무효화 — admin cancel 이 누락하던 갭
    # (취소된 행사가 events:search/list 캐시에 TTL(5분)까지 잔존하던 문제).
    from app.api.v1.events import _invalidate_event_caches
    await _invalidate_event_caches(event_id)

    return {
        "detail": "Event cancelled by admin",
        "event_id": str(event_id),
        "orders": order_summary,
    }


@router.get("/admin/communities", response_model=AdminCommunityListResponse)
async def list_communities(
    q: str | None = None,
    community_type: str | None = None,
    is_official: bool | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(require_scope("communities.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    svc = AdminService(db)
    communities, total = await svc.list_communities(
        is_official, skip, limit, q=q, community_type=community_type
    )
    items = [AdminCommunityItem(**c) for c in communities]
    return AdminCommunityListResponse(communities=items, total=total)


@router.post("/admin/communities/{community_id}/official")
async def toggle_community_official(
    community_id: uuid.UUID,
    admin: User = Depends(require_scope("communities.manage")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Fanclub).where(Fanclub.id == community_id))
    fc = result.scalar_one_or_none()
    if not fc:
        raise HTTPException(status_code=404, detail="Community not found")
    old_official = fc.is_official
    fc.is_official = not fc.is_official
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="community.toggle_official",
        resource_type="community",
        resource_id=str(community_id),
        old_value={"is_official": old_official},
        new_value={"is_official": fc.is_official},
    )
    await db.commit()
    return {
        "detail": f"Official {'enabled' if fc.is_official else 'disabled'}",
        "is_official": fc.is_official,
    }


@router.get("/admin/audit", response_model=AuditLogResponse)
async def get_audit_log(
    event_id: str | None = None,
    action: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(require_scope("audit.view")),
    db: AsyncSession = Depends(get_read_db),
):
    svc = AdminService(db)
    entries, total = await svc.get_audit_log(
        event_id, action, skip, limit, date_from=date_from, date_to=date_to
    )
    items = [
        AuditEntryResponse(
            id=e.id,
            event_id=e.event_id,
            action=e.action,
            actor_id=e.actor_id,
            resource_type=e.resource_type,
            resource_id=e.resource_id,
            old_value=e.old_value,
            new_value=e.new_value,
            created_at=e.created_at,
        )
        for e in entries
    ]
    return AuditLogResponse(entries=items, total=total)


@router.get("/admin/organizer-profiles")
async def list_organizer_profiles(
    status: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(require_scope("organizers.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: list organizer onboarding profiles."""
    from app.models.organizer import OrganizerProfile

    conditions = []
    if status:
        conditions.append(OrganizerProfile.status == status)
    q = (
        select(OrganizerProfile)
        .order_by(OrganizerProfile.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    if conditions:
        q = q.where(*conditions)
    result = await db.execute(q)
    profiles = result.scalars().all()
    return [
        {
            "id": str(p.id),
            "user_id": str(p.user_id),
            "company_name": p.company_name,
            "business_number": p.business_number,
            "representative_name": p.representative_name,
            "address": p.address,
            "contact_phone": p.contact_phone,
            "contact_email": p.contact_email,
            "primary_domains": p.primary_domains,
            "status": p.status.value if hasattr(p.status, "value") else str(p.status),
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in profiles
    ]


@router.patch("/admin/organizer-profiles/{profile_id}")
async def review_organizer_profile(
    profile_id: uuid.UUID,
    data: dict,
    user: User = Depends(require_scope("organizers.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: approve or reject an organizer onboarding profile."""
    from app.models.organizer import OrganizerProfile
    from datetime import datetime, timezone

    profile = (
        await db.execute(select(OrganizerProfile).where(OrganizerProfile.id == profile_id))
    ).scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if data.get("approved"):
        profile.status = "approved"
        profile.approved_at = datetime.now(timezone.utc)
        # Also promote the user to organizer role
        target_user = (
            await db.execute(select(User).where(User.id == profile.user_id))
        ).scalar_one_or_none()
        if target_user:
            target_user.is_organizer = True
    else:
        profile.status = "rejected"
        profile.rejection_reason = data.get("rejection_reason", "")

    await write_audit_log(
        db,
        actor_id=user.id,
        action="admin.organizer_review",
        resource_type="organizer_profile",
        resource_id=str(profile_id),
        new_value={"status": profile.status, "user_id": str(profile.user_id)},
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(profile.user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(profile.user_id)
    return {"detail": "Profile reviewed", "status": profile.status}


# ════════════════════════════════════════════════════════════════════
# CS: User orders / tickets
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/users/{user_id}/orders", response_model=AdminOrderListResponse)
async def get_user_orders(
    user_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin CS: get all orders for a specific user."""
    svc = AdminService(db)
    orders, total = await svc.get_user_orders(user_id, skip, limit)
    return AdminOrderListResponse(
        orders=[AdminOrderItem(**o) for o in orders],
        total=total,
    )


@router.get("/admin/users/{user_id}/tickets", response_model=AdminTicketListResponse)
async def get_user_tickets(
    user_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin CS: get all tickets for a specific user."""
    svc = AdminService(db)
    tickets, total = await svc.get_user_tickets(user_id, skip, limit)
    return AdminTicketListResponse(
        tickets=[AdminTicketItem(**t) for t in tickets],
        total=total,
    )


# ════════════════════════════════════════════════════════════════════
# Global order search
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/orders", response_model=AdminOrderListResponse)
async def search_orders(
    q: str | None = None,
    status: str | None = None,
    event_id: uuid.UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("orders.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: global order search with filters."""
    svc = AdminService(db)
    orders, total = await svc.search_orders(q, status, event_id, date_from, date_to, skip, limit)
    return AdminOrderListResponse(
        orders=[AdminOrderItem(**o) for o in orders],
        total=total,
    )


# ════════════════════════════════════════════════════════════════════
# Bulk operations
# ════════════════════════════════════════════════════════════════════


@router.post("/admin/bulk/users/ban", response_model=BulkActionResponse)
async def bulk_ban_users(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: ban multiple users at once."""
    svc = AdminService(db)
    result = await svc.bulk_ban_users(data.ids, data.reason)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_ban_users",
        resource_type="user",
        new_value={"user_ids": [str(i) for i in data.ids], "reason": data.reason, **result},
    )
    await db.commit()

    await alert_critical_admin_action(
        action="admin.bulk.ban",
        admin_id=admin.id,
        admin_email=admin.email,
        admin_role=getattr(admin, "admin_role", "unknown"),
        target=f"{len(data.ids)}명 대량 차단",
        details={"대상 수": len(data.ids), "사유": data.reason or "N/A"},
    )

    return BulkActionResponse(**result)


@router.post("/admin/bulk/users/unban", response_model=BulkActionResponse)
async def bulk_unban_users(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("users.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: unban multiple users at once."""
    svc = AdminService(db)
    result = await svc.bulk_unban_users(data.ids)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_unban_users",
        resource_type="user",
        new_value={"user_ids": [str(i) for i in data.ids], **result},
    )
    await db.commit()
    return BulkActionResponse(**result)


@router.post("/admin/bulk/events/cancel", response_model=BulkActionResponse)
async def bulk_cancel_events(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: cancel multiple events at once."""
    svc = AdminService(db)
    result = await svc.bulk_cancel_events(data.ids, data.reason)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_cancel_events",
        resource_type="event",
        new_value={"event_ids": [str(i) for i in data.ids], "reason": data.reason, **result},
    )
    await db.commit()

    await alert_critical_admin_action(
        action="admin.bulk.cancel",
        admin_id=admin.id,
        admin_email=admin.email,
        admin_role=getattr(admin, "admin_role", "unknown"),
        target=f"{len(data.ids)}개 이벤트 대량 취소",
        details={"대상 수": len(data.ids), "사유": data.reason or "N/A"},
    )

    return BulkActionResponse(**result)


@router.post("/admin/bulk/events/feature", response_model=BulkActionResponse)
async def bulk_feature_events(
    data: BulkActionRequest,
    featured: bool = Query(True),
    admin: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: set featured status for multiple events."""
    svc = AdminService(db)
    result = await svc.bulk_feature_events(data.ids, featured)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_feature_events",
        resource_type="event",
        new_value={"event_ids": [str(i) for i in data.ids], "featured": featured, **result},
    )
    await db.commit()
    return BulkActionResponse(**result)


@router.post("/admin/bulk/events/review", response_model=BulkActionResponse)
async def bulk_review_events(
    data: BulkEventReviewRequest,
    admin: User = Depends(require_scope("events.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: review multiple events at once (approve/reject/revision_requested)."""
    svc = AdminService(db)
    result = await svc.bulk_review_events(data.ids, data.action, data.comment, reviewer_id=admin.id)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action=f"admin.bulk_review_events.{data.action}",
        resource_type="event",
        new_value={
            "event_ids": [str(i) for i in data.ids],
            "action": data.action,
            "comment": data.comment,
            **result,
        },
    )
    await db.commit()
    return BulkActionResponse(**result)


@router.post("/admin/bulk/orders/refund", response_model=BulkActionResponse)
async def bulk_refund_orders(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("orders.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: process refund for multiple orders (status change only, PG refund is separate)."""
    svc = AdminService(db)
    result = await svc.bulk_refund_orders(data.ids, data.reason)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_refund_orders",
        resource_type="order",
        new_value={"order_ids": [str(i) for i in data.ids], "reason": data.reason, **result},
    )
    await db.commit()

    await alert_critical_admin_action(
        action="admin.bulk.refund",
        admin_id=admin.id,
        admin_email=admin.email,
        admin_role=getattr(admin, "admin_role", "unknown"),
        target=f"{len(data.ids)}건 대량 환불",
        details={"대상 수": len(data.ids), "사유": data.reason or "N/A"},
    )

    return BulkActionResponse(**result)


@router.post("/admin/bulk/organizers/approve", response_model=BulkActionResponse)
async def bulk_approve_organizers(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("organizers.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: approve multiple organizer profiles at once."""
    svc = AdminService(db)
    result = await svc.bulk_approve_organizers(data.ids)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_approve_organizers",
        resource_type="organizer",
        new_value={"profile_ids": [str(i) for i in data.ids], **result},
    )
    await db.commit()
    return BulkActionResponse(**result)


@router.post("/admin/bulk/organizers/reject", response_model=BulkActionResponse)
async def bulk_reject_organizers(
    data: BulkActionRequest,
    admin: User = Depends(require_scope("organizers.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: reject multiple organizer profiles at once."""
    svc = AdminService(db)
    result = await svc.bulk_reject_organizers(data.ids, data.reason)
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.bulk_reject_organizers",
        resource_type="organizer",
        new_value={"profile_ids": [str(i) for i in data.ids], "reason": data.reason, **result},
    )
    await db.commit()
    return BulkActionResponse(**result)


# ════════════════════════════════════════════════════════════════════
# Finance
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/finance/summary", response_model=FinanceSummaryResponse)
async def finance_summary(
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    period: str | None = Query(None, description="7d, 30d, 90d for daily breakdown"),
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: platform-wide financial summary."""
    svc = FinanceService(db)
    result = await svc.get_summary(date_from, date_to, period)
    return FinanceSummaryResponse(**result)


@router.get("/admin/finance/by-event", response_model=FinanceByEventResponse)
async def finance_by_event(
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    sort: str | None = None,
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: revenue breakdown by event."""
    svc = FinanceService(db)
    events, total = await svc.get_by_event(date_from, date_to, skip, limit, sort)
    return FinanceByEventResponse(
        events=[FinanceByEventItem(**e) for e in events],
        total=total,
    )


@router.get("/admin/finance/by-organizer", response_model=FinanceByOrganizerResponse)
async def finance_by_organizer(
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: revenue breakdown by organizer."""
    svc = FinanceService(db)
    organizers, total = await svc.get_by_organizer(date_from, date_to, skip, limit)
    return FinanceByOrganizerResponse(
        organizers=[FinanceByOrganizerItem(**o) for o in organizers],
        total=total,
    )


@router.post("/admin/settlements/{settlement_id}/review")
async def review_settlement(
    settlement_id: uuid.UUID,
    admin: User = Depends(require_scope("settlements.review")),
    db: AsyncSession = Depends(get_db),
):
    svc = FinanceService(db)
    try:
        settlement = await svc.review_settlement(settlement_id, reviewer_id=admin.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Settlement review failed for %s", settlement_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(exc, "정산 검토에 실패했습니다."),
        ) from exc

    await db.commit()
    return {
        "settlement_id": str(settlement.id),
        "status": settlement.status,
        "reviewed_by": str(admin.id),
        "reviewed_at": settlement.reviewed_at.isoformat() if settlement.reviewed_at else None,
    }


@router.post("/admin/settlements/{settlement_id}/approve")
async def approve_settlement(
    settlement_id: uuid.UUID,
    admin: User = Depends(require_scope("settlements.approve")),
    db: AsyncSession = Depends(get_db),
):
    svc = FinanceService(db)
    try:
        settlement = await svc.approve_settlement(settlement_id, approver_id=admin.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Settlement approval failed for %s", settlement_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(exc, "정산 승인에 실패했습니다."),
        ) from exc

    await db.commit()
    return {
        "settlement_id": str(settlement.id),
        "status": settlement.status,
        "approved_by": str(admin.id),
        "approved_at": settlement.approved_at.isoformat() if settlement.approved_at else None,
    }


# ════════════════════════════════════════════════════════════════════
# Refund approvals
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/refunds/pending")
async def pending_refunds(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    q: str | None = Query(None),
    status: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    admin: User = Depends(require_scope("refunds.approve")),
    db: AsyncSession = Depends(get_read_db),
):
    from app.models.refund import Refund, RefundStatus
    from sqlalchemy import func
    from sqlalchemy.orm import selectinload

    query = select(Refund).options(selectinload(Refund.items))
    count_q = select(func.count(Refund.id))

    if status and status != "all":
        try:
            query = query.where(Refund.status == RefundStatus(status))
            count_q = count_q.where(Refund.status == RefundStatus(status))
        except ValueError:
            logger.debug("invalid refund status filter: %s", status, exc_info=True)
    else:
        # default: show all non-completed statuses
        pass

    if date_from:
        from datetime import datetime as dt
        df = dt.fromisoformat(date_from)
        query = query.where(Refund.requested_at >= df)
        count_q = count_q.where(Refund.requested_at >= df)
    if date_to:
        from datetime import datetime as dt
        dt_ = dt.fromisoformat(date_to)
        query = query.where(Refund.requested_at <= dt_)
        count_q = count_q.where(Refund.requested_at <= dt_)

    total = (await db.execute(count_q)).scalar() or 0
    result = await db.execute(
        query.order_by(Refund.requested_at.asc()).offset(skip).limit(limit)
    )
    refunds = list(result.scalars().all())

    # 원주문 총액(original_amount) — 환불액의 전체/부분 여부 판단용(P2 Major). 배치 조회.
    from app.models.order import Order

    order_ids = [r.order_id for r in refunds]
    order_totals: dict[uuid.UUID, float] = {}
    if order_ids:
        total_rows = await db.execute(
            select(Order.id, Order.total_amount).where(Order.id.in_(order_ids))
        )
        order_totals = {oid: float(amt or 0) for oid, amt in total_rows.all()}

    items = [
        {
            "refund_id": str(refund.id),
            "order_id": str(refund.order_id),
            "status": refund.status,
            "refund_type": refund.refund_type,
            "amount": float(refund.amount),
            "original_amount": order_totals.get(refund.order_id),
            "currency": refund.currency,
            "reason": refund.reason,
            "initiated_by": refund.initiated_by,
            "requested_at": refund.requested_at.isoformat() if refund.requested_at else None,
            "ticket_ids": [str(item.ticket_id) for item in refund.items],
        }
        for refund in refunds
    ]
    return {"refunds": items, "total": total}


@router.post("/admin/refunds/{refund_id}/approve")
async def approve_refund(
    refund_id: uuid.UUID,
    admin: User = Depends(require_scope("refunds.approve")),
    db: AsyncSession = Depends(get_db),
):
    svc = RefundService(db)
    try:
        refund = await svc.approve_refund(refund_id, admin_id=admin.id)
    except RefundError as exc:
        logger.warning("Refund approval failed for %s", refund_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(exc, "환불 승인에 실패했습니다."),
        ) from exc

    await db.commit()

    # PR-U2: v2 → go propagation (order.refunded), after commit
    from app.api.v1.orders import _drain_propagations
    _drain_propagations(svc.propagations)

    return {
        "refund_id": str(refund.id),
        "status": refund.status,
        "approved_by": str(admin.id),
        "processed_at": refund.processed_at.isoformat() if refund.processed_at else None,
    }


@router.post("/admin/refunds/{refund_id}/reject")
async def reject_refund(
    refund_id: uuid.UUID,
    data: RefundDecisionRequest,
    admin: User = Depends(require_scope("refunds.approve")),
    db: AsyncSession = Depends(get_db),
):
    reason = (data.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Rejection reason is required")

    svc = RefundService(db)
    try:
        refund = await svc.reject_refund(
            refund_id,
            admin_id=admin.id,
            rejection_reason=reason,
        )
    except RefundError as exc:
        logger.warning("Refund rejection failed for %s", refund_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(exc, "환불 반려에 실패했습니다."),
        ) from exc

    await db.commit()
    return {
        "refund_id": str(refund.id),
        "status": refund.status,
        "rejection_reason": refund.rejection_reason,
    }


# ════════════════════════════════════════════════════════════════════
# Notifications
# ════════════════════════════════════════════════════════════════════


@router.post("/admin/notifications/send")
async def send_notification(
    data: AdminNotificationSend,
    admin: User = Depends(require_scope("notifications.send")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: send notification to specific users."""
    svc = NotificationAdminService(db)
    count = await svc.send_to_users(
        sender_id=admin.id,
        user_ids=data.user_ids,
        title=data.title,
        message=data.message,
        notification_type=data.notification_type,
    )
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.notification_send",
        resource_type="notification",
        new_value={"user_count": count, "title": data.title, "type": data.notification_type},
    )
    await db.commit()
    return {"detail": f"Notification sent to {count} users", "count": count}


@router.post("/admin/notifications/broadcast")
async def broadcast_notification(
    data: AdminNotificationBroadcast,
    admin: User = Depends(require_scope("notifications.send")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: broadcast notification to user groups."""
    if data.target not in ("all", "organizers", "users"):
        raise HTTPException(
            status_code=400, detail="target must be 'all', 'organizers', or 'users'"
        )
    svc = NotificationAdminService(db)
    count = await svc.broadcast(
        sender_id=admin.id,
        target=data.target,
        title=data.title,
        message=data.message,
    )
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="admin.notification_broadcast",
        resource_type="notification",
        new_value={"target": data.target, "user_count": count, "title": data.title},
    )
    await db.commit()
    return {"detail": f"Broadcast sent to {count} users", "count": count}


@router.get("/admin/notifications/history", response_model=AdminNotificationHistoryResponse)
async def notification_history(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("notifications.send")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: get notification sending history."""
    svc = NotificationAdminService(db)
    notifications, total = await svc.get_history(skip, limit)
    return AdminNotificationHistoryResponse(
        notifications=[AdminNotificationHistoryItem(**n) for n in notifications],
        total=total,
    )


# ════════════════════════════════════════════════════════════════════
# RBAC: Admin role update
# ════════════════════════════════════════════════════════════════════


@router.put("/admin/users/{user_id}/role")
async def update_admin_role(
    user_id: uuid.UUID,
    data: AdminRoleUpdate,
    admin: User = Depends(require_scope("*")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: update a user's admin role or remove admin access."""
    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    valid_roles = {"super_admin", "admin", "moderator", "finance_admin", "cs_agent", "viewer", None}
    if data.admin_role not in valid_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {valid_roles}")

    if target.id == admin.id and data.admin_role is None:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin access")

    if target.admin_role == "super_admin" and (data.admin_role is None or data.admin_role != "super_admin"):
        super_admin_count = (
            await db.execute(
                select(User.id).where(
                    User.is_admin.is_(True),
                    User.admin_role == "super_admin",
                )
            )
        ).scalars().all()
        if len(super_admin_count) <= 1:
            raise HTTPException(status_code=400, detail="At least one super_admin must remain")

    old_role = {"admin_role": target.admin_role, "is_admin": target.is_admin}
    if data.admin_role is None:
        # Remove admin access
        target.is_admin = False
        target.admin_role = "viewer"
    else:
        # Grant admin access and set the specific role
        target.is_admin = True
        target.admin_role = data.admin_role

    await write_audit_log(
        db,
        actor_id=admin.id,
        action="user.admin_role_change",
        resource_type="user",
        resource_id=str(user_id),
        old_value=old_role,
        new_value={"admin_role": data.admin_role, "is_admin": target.is_admin},
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(user_id)
    return {
        "detail": "Admin role updated",
        "user_id": str(user_id),
        "admin_role": target.admin_role if target.is_admin else None,
        "is_admin": target.is_admin,
    }


# ════════════════════════════════════════════════════════════════════
# Feature Flags
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/feature-flags")
async def get_feature_flags(
    user: User = Depends(require_scope("*")),
):
    """Get all feature flags (super_admin only).

    Feature flags gate payment/purchase flows, so reads and writes are
    restricted to super_admin ('*'); low-privilege admin roles (viewer,
    cs_agent, moderator) must not see or toggle them.
    """
    from app.core.feature_flags import get_all_flags

    return await get_all_flags()


@router.put("/admin/feature-flags/{key}")
async def update_feature_flag(
    key: str,
    request: Request,
    user: User = Depends(require_scope("*")),
    db: AsyncSession = Depends(get_db),
):
    """Set a feature flag value (super_admin only)."""
    from app.core.feature_flags import set_feature_flag

    body = await request.json()
    value = body.get("value")
    if value is None:
        raise HTTPException(status_code=400, detail="Missing 'value' field")
    success = await set_feature_flag(key, value)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update feature flag")
    await write_audit_log(
        db,
        actor_id=user.id,
        action="admin.feature_flag_update",
        resource_type="feature_flag",
        resource_id=key,
        new_value={"key": key, "value": value},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    return {"key": key, "value": value}


# ════════════════════════════════════════════════════════════════════
# Custom Reports
# ════════════════════════════════════════════════════════════════════


REPORT_TYPES = [
    {"key": "sales_summary", "label": "매출 요약", "description": "기간별 매출, 주문수, 티켓수"},
    {"key": "user_growth", "label": "사용자 성장", "description": "기간별 가입자 수 추이"},
    {
        "key": "event_performance",
        "label": "이벤트 성과",
        "description": "이벤트별 매출, 판매율, 예매수",
    },
    {"key": "refund_analysis", "label": "환불 분석", "description": "환불 건수, 금액, 환불률 분석"},
]


@router.get("/admin/reports/types")
async def get_report_types(
    admin: User = Depends(require_scope("finance.view")),
):
    """Admin: get available report types."""
    return REPORT_TYPES


@router.post("/admin/reports/generate", response_model=ReportResponse)
async def generate_report(
    data: ReportRequest,
    admin: User = Depends(require_scope("finance.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: generate a custom report."""
    valid_types = {rt["key"] for rt in REPORT_TYPES}
    if data.report_type not in valid_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid report_type. Must be one of: {', '.join(valid_types)}",
        )

    svc = AdminService(db)
    result = await svc.generate_report(
        report_type=data.report_type,
        date_from=data.date_from,
        date_to=data.date_to,
    )

    return ReportResponse(
        report_type=data.report_type,
        generated_at=datetime.utcnow(),
        data=result["data"],
        summary=result["summary"],
    )


# ════════════════════════════════════════════════════════════════════
# Exchange Rates
# ════════════════════════════════════════════════════════════════════


# ════════════════════════════════════════════════════════════════════
# Template Change Requests (WP05)
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/template-change-requests")
async def list_template_change_requests(
    status_filter: str | None = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("communities.manage")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: list all template change requests."""
    from app.models.template_change import TemplateChangeRequest
    from sqlalchemy import func

    query = select(TemplateChangeRequest).order_by(TemplateChangeRequest.created_at.desc())
    count_query = select(func.count(TemplateChangeRequest.id))

    if status_filter:
        query = query.where(TemplateChangeRequest.status == status_filter)
        count_query = count_query.where(TemplateChangeRequest.status == status_filter)

    total = (await db.execute(count_query)).scalar() or 0
    result = await db.execute(query.offset(skip).limit(limit))
    requests = result.scalars().all()

    return {
        "requests": [
            {
                "id": str(r.id),
                "fanclub_id": str(r.fanclub_id),
                "old_template": r.old_template,
                "new_template": r.new_template,
                "reason": r.reason,
                "requested_by": str(r.requested_by),
                "status": r.status,
                "reviewed_by": str(r.reviewed_by) if r.reviewed_by else None,
                "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
                "rejection_reason": r.rejection_reason,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in requests
        ],
        "total": total,
    }


@router.post("/admin/template-change-requests/{request_id}/approve")
async def approve_template_change(
    request_id: uuid.UUID,
    admin: User = Depends(require_scope("communities.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: approve a template change request and apply to fanclub."""
    from app.models.template_change import TemplateChangeRequest, TemplateChangeStatus
    from app.core.audit import write_audit_log

    result = await db.execute(
        select(TemplateChangeRequest).where(TemplateChangeRequest.id == request_id)
    )
    change_req = result.scalar_one_or_none()
    if not change_req:
        raise HTTPException(status_code=404, detail="Template change request not found")

    if change_req.status != TemplateChangeStatus.PENDING.value:
        raise HTTPException(status_code=400, detail="Request is not in pending status")

    # Approve the request
    change_req.status = TemplateChangeStatus.APPROVED.value
    change_req.reviewed_by = admin.id
    change_req.reviewed_at = datetime.utcnow()

    # Apply the template change to the fanclub
    fc_result = await db.execute(select(Fanclub).where(Fanclub.id == change_req.fanclub_id))
    fanclub = fc_result.scalar_one_or_none()
    if fanclub:
        fanclub.event_type_template = change_req.new_template

    # Audit log (event_id=None for community-level actions) — WP-16 통합
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="weight_template_change_approved",
        resource_type="admin_action",
        resource_id=str(request_id),
        new_value={
            "request_id": str(request_id),
            "fanclub_id": str(change_req.fanclub_id),
            "old_template": change_req.old_template,
            "new_template": change_req.new_template,
            "requested_by": str(change_req.requested_by),
            "result": "success",
        },
    )

    await db.commit()
    return {
        "detail": "Template change approved and applied",
        "request_id": str(request_id),
        "fanclub_id": str(change_req.fanclub_id),
        "new_template": change_req.new_template,
    }


class TemplateRejectBody(BaseModel):
    reason: str = ""


@router.post("/admin/template-change-requests/{request_id}/reject")
async def reject_template_change(
    request_id: uuid.UUID,
    body: TemplateRejectBody = TemplateRejectBody(),
    admin: User = Depends(require_scope("communities.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Admin: reject a template change request."""
    from app.models.template_change import TemplateChangeRequest, TemplateChangeStatus
    from app.core.audit import write_audit_log

    result = await db.execute(
        select(TemplateChangeRequest).where(TemplateChangeRequest.id == request_id)
    )
    change_req = result.scalar_one_or_none()
    if not change_req:
        raise HTTPException(status_code=404, detail="Template change request not found")

    if change_req.status != TemplateChangeStatus.PENDING.value:
        raise HTTPException(status_code=400, detail="Request is not in pending status")

    change_req.status = TemplateChangeStatus.REJECTED.value
    change_req.reviewed_by = admin.id
    change_req.reviewed_at = datetime.utcnow()
    change_req.rejection_reason = body.reason

    # Audit log (event_id=None for community-level actions) — WP-16 통합
    await write_audit_log(
        db,
        actor_id=admin.id,
        action="weight_template_change_rejected",
        resource_type="admin_action",
        resource_id=str(request_id),
        new_value={
            "request_id": str(request_id),
            "fanclub_id": str(change_req.fanclub_id),
            "old_template": change_req.old_template,
            "new_template": change_req.new_template,
            "rejection_reason": body.reason,
            "requested_by": str(change_req.requested_by),
            "result": "success",
        },
    )

    await db.commit()
    return {
        "detail": "Template change rejected",
        "request_id": str(request_id),
        "rejection_reason": body.reason,
    }


# ════════════════════════════════════════════════════════════════════
# Phase C WP-C3: Audit Logs (범용 감사 추적)
# ════════════════════════════════════════════════════════════════════


@router.get("/admin/audit-logs")
async def get_audit_logs(
    action: str | None = None,
    resource_type: str | None = None,
    actor_id: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: User = Depends(require_scope("audit.view")),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: 범용 감사 로그 조회 (페이지네이션, 필터)."""
    from app.models.audit_log import AuditLog
    from sqlalchemy import func as sa_func

    query = select(AuditLog).order_by(AuditLog.created_at.desc())
    count_query = select(sa_func.count(AuditLog.id))

    conditions = []
    if action:
        conditions.append(AuditLog.action == action)
    if resource_type:
        conditions.append(AuditLog.resource_type == resource_type)
    if actor_id:
        conditions.append(AuditLog.actor_id == uuid.UUID(actor_id))
    if date_from:
        conditions.append(AuditLog.created_at >= date_from)
    if date_to:
        conditions.append(AuditLog.created_at <= date_to)

    if conditions:
        query = query.where(*conditions)
        count_query = count_query.where(*conditions)

    total = (await db.execute(count_query)).scalar() or 0
    result = await db.execute(query.offset(skip).limit(limit))
    logs = result.scalars().all()

    return {
        "logs": [
            {
                "id": str(log.id),
                "actor_id": str(log.actor_id) if log.actor_id else None,
                "action": log.action,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "old_value": log.old_value,
                "new_value": log.new_value,
                "ip_address": log.ip_address,
                "user_agent": log.user_agent[:200] if log.user_agent else None,
                "created_at": log.created_at.isoformat() if log.created_at else None,
            }
            for log in logs
        ],
        "total": total,
    }


@router.get("/exchange-rates/{from_currency}/{to_currency}")
async def get_exchange_rate(
    from_currency: str,
    to_currency: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Get exchange rate between two currencies (public endpoint)."""
    from app.services.exchange_rate_service import ExchangeRateService

    svc = ExchangeRateService(db)
    rate = await svc.get_rate(from_currency.upper(), to_currency.upper())
    return {"from": from_currency.upper(), "to": to_currency.upper(), "rate": float(rate)}
