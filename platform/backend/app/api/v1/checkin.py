"""Check-in API endpoints for public sector events."""

import hashlib
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import client_error_detail
from app.core.database import get_db
from app.core.redis import get_redis
from app.middleware.auth import get_current_user
from app.middleware.rate_limit import rate_limit_checkin
from app.models.event import Event
from app.models.event_staff import EventStaffAssignment, EventStaffRole
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.attendance import (
    AttendanceStats,
    CheckInRequest,
    CheckInResponse,
    CheckInStaffAssignmentRequest,
    CheckInStaffAssignmentResponse,
    NoShowProcessResult,
)
from app.schemas.checkin_ops import CheckinAttendeeListResponse
from app.services.checkin_service import CheckInService
from app.services.dynamic_qr_service import verify_qr, TOTPQRService

router = APIRouter()


def _checkin_qr_replay_key(qr_data: str) -> str:
    # v2: prefix per DOMAIN_MODEL_STANDARD §7. QR replay TTL is short so
    # legacy keys ("checkin:qr:used:*") expire naturally within the replay window.
    from app.core.redis import v2_key
    return v2_key(f"checkin:qr:used:{hashlib.sha256(qr_data.encode('utf-8')).hexdigest()}")


async def _mark_qr_as_used(qr_data: str) -> None:
    try:
        redis = get_redis()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Check-in service is temporarily unavailable",
        ) from exc

    created = await redis.set(
        _checkin_qr_replay_key(qr_data),
        "1",
        nx=True,
        ex=max(settings.CHECKIN_REPLAY_TTL_SECONDS, settings.CHECKIN_QR_MAX_AGE_SECONDS * 2),
    )
    if not created:
        raise HTTPException(status_code=409, detail="QR code already used")


async def _get_event_or_404(db: AsyncSession, event_id: uuid.UUID) -> Event:
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


async def _assert_checkin_access(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    current_user: User,
    allow_staff: bool,
) -> Event:
    event = await _get_event_or_404(db, event_id)
    if current_user.is_admin or event.organizer_id == current_user.id:
        return event
    if not allow_staff:
        raise HTTPException(status_code=403, detail="Organizer or admin access required")

    staff_result = await db.execute(
        select(EventStaffAssignment).where(
            EventStaffAssignment.event_id == event_id,
            EventStaffAssignment.user_id == current_user.id,
            EventStaffAssignment.is_active.is_(True),
        )
    )
    if staff_result.scalar_one_or_none():
        return event
    raise HTTPException(status_code=403, detail="Event staff access required")


async def _resolve_ticket_id(
    db: AsyncSession,
    req: CheckInRequest,
    *,
    can_manual_override: bool,
) -> uuid.UUID:
    if req.qr_data:
        ticket_id = None
        # Try TOTP verification first if enabled
        if settings.TOTP_ENABLED:
            # Extract ticket_id from the TOTP payload ("ticket_id|totp_code|device_hash")
            parts = req.qr_data.split("|")
            if len(parts) == 3:
                try:
                    candidate_ticket_id = uuid.UUID(parts[0])
                except ValueError:
                    pass
                else:
                    # Query ticket to get totp_seed and device_hash
                    result = await db.execute(
                        select(Ticket).where(Ticket.id == candidate_ticket_id)
                    )
                    ticket = result.scalar_one_or_none()
                    if ticket and ticket.totp_seed and ticket.device_hash:
                        is_valid, error_msg = TOTPQRService.verify_qr(
                            req.qr_data, ticket.totp_seed, ticket.device_hash
                        )
                        if is_valid:
                            ticket_id = candidate_ticket_id
        # Fall back to legacy HMAC verification
        if not ticket_id:
            ticket_id = verify_qr(
                req.qr_data,
                settings.QR_HMAC_SECRET,  # AUDIT §25 P0: QR 도메인 전용 시크릿
                max_age_seconds=settings.CHECKIN_QR_MAX_AGE_SECONDS,
            )
        if not ticket_id:
            raise HTTPException(status_code=400, detail="Invalid or expired QR code")
        return ticket_id

    if req.ticket_id:
        if settings.CHECKIN_REQUIRE_QR and not can_manual_override:
            raise HTTPException(
                status_code=400,
                detail="Signed QR code is required for staff check-in",
            )
        return req.ticket_id

    raise HTTPException(status_code=400, detail="QR code or ticket id is required")


def _parse_staff_role(role: str) -> EventStaffRole:
    try:
        return EventStaffRole(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid staff role") from exc


def _staff_assignment_response(assignment: EventStaffAssignment) -> CheckInStaffAssignmentResponse:
    return CheckInStaffAssignmentResponse(
        event_id=assignment.event_id,
        user_id=assignment.user_id,
        role=assignment.role.value,
        is_active=assignment.is_active,
        created_at=assignment.created_at,
    )


@router.get("/checkin/my-events")
async def get_my_checkin_events(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List events accessible to the current user for check-in."""
    query = select(Event)
    if not current_user.is_admin and not current_user.is_organizer:
        query = query.join(
            EventStaffAssignment,
            EventStaffAssignment.event_id == Event.id,
        ).where(
            EventStaffAssignment.user_id == current_user.id,
            EventStaffAssignment.is_active.is_(True),
        )
    elif not current_user.is_admin:
        query = query.where(
            or_(
                Event.organizer_id == current_user.id,
                Event.id.in_(
                    select(EventStaffAssignment.event_id).where(
                        EventStaffAssignment.user_id == current_user.id,
                        EventStaffAssignment.is_active.is_(True),
                    )
                ),
            )
        )

    result = await db.execute(query.order_by(Event.event_date.desc()).limit(100))
    events = result.scalars().all()
    return [{"id": str(event.id), "title": event.title} for event in events]


@router.post("/{event_id}/checkin", response_model=CheckInResponse)
async def check_in(
    event_id: uuid.UUID,
    req: CheckInRequest,
    _rate_limit: None = Depends(rate_limit_checkin),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check in a ticket via QR scan (staff operation)."""
    event = await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=True,
    )
    can_manual_override = current_user.is_admin or event.organizer_id == current_user.id
    ticket_id = await _resolve_ticket_id(db, req, can_manual_override=can_manual_override)
    if req.qr_data:
        await _mark_qr_as_used(req.qr_data)

    service = CheckInService(db)
    try:
        attendance, deposit_refunded = await service.check_in(
            event_id=event_id,
            ticket_id=ticket_id,
            scanner_user_id=current_user.id,
            method=req.method,
        )
        await db.commit()
        return CheckInResponse(
            attendance_id=attendance.id,
            ticket_id=attendance.ticket_id,
            user_id=attendance.user_id,
            event_id=attendance.event_id,
            checked_in_at=attendance.checked_in_at,
            method=attendance.method,
            deposit_refunded=deposit_refunded,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "체크인 처리 중 오류가 발생했습니다"))


@router.get("/{event_id}/checkin/stats", response_model=AttendanceStats)
async def get_checkin_stats(
    event_id: uuid.UUID,
    _rate_limit: None = Depends(rate_limit_checkin),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get real-time attendance statistics."""
    await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=True,
    )
    service = CheckInService(db)
    return await service.get_stats(event_id)


@router.get("/{event_id}/checkin/attendees", response_model=CheckinAttendeeListResponse)
async def get_checkin_attendees(
    event_id: uuid.UUID,
    q: str | None = Query(None, max_length=100),
    status: str | None = Query(None, pattern="^(active|checked_in|no_show)$"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List attendees for on-site check-in operations."""
    await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=True,
    )
    service = CheckInService(db)
    attendees, total = await service.list_attendees(
        event_id,
        q=q,
        status=status,
        skip=skip,
        limit=limit,
    )
    return CheckinAttendeeListResponse(attendees=attendees, total=total)


@router.post("/{event_id}/checkin/process-noshows", response_model=NoShowProcessResult)
async def process_noshows(
    event_id: uuid.UUID,
    _rate_limit: None = Depends(rate_limit_checkin),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Process no-shows and forfeit deposits."""
    event = await _get_event_or_404(db, event_id)
    if not current_user.is_admin and event.organizer_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the event organizer or an admin can process no-shows",
        )
    service = CheckInService(db)
    try:
        result = await service.process_no_shows(event_id)
        await db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "체크인 처리 중 오류가 발생했습니다"))


@router.get(
    "/{event_id}/checkin/staff",
    response_model=list[CheckInStaffAssignmentResponse],
)
async def list_checkin_staff(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List active check-in staff for an event (organizer/admin only)."""
    await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=False,
    )
    staff_result = await db.execute(
        select(EventStaffAssignment).where(
            EventStaffAssignment.event_id == event_id,
            EventStaffAssignment.is_active.is_(True),
        )
    )
    assignments = staff_result.scalars().all()
    return [_staff_assignment_response(a) for a in assignments]


@router.post(
    "/{event_id}/checkin/staff",
    response_model=CheckInStaffAssignmentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_checkin_staff(
    event_id: uuid.UUID,
    body: CheckInStaffAssignmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign an event staff account (organizer/admin only)."""
    await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=False,
    )

    target_user_result = await db.execute(
        select(User).where(User.id == body.user_id, User.is_active.is_(True))
    )
    if not target_user_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="User not found")

    role = _parse_staff_role(body.role)
    assignment_result = await db.execute(
        select(EventStaffAssignment).where(
            EventStaffAssignment.event_id == event_id,
            EventStaffAssignment.user_id == body.user_id,
        )
    )
    assignment = assignment_result.scalar_one_or_none()
    if assignment:
        assignment.role = role
        assignment.is_active = True
        assignment.created_by = current_user.id
    else:
        assignment = EventStaffAssignment(
            event_id=event_id,
            user_id=body.user_id,
            role=role,
            is_active=True,
            created_by=current_user.id,
        )
        db.add(assignment)

    await db.commit()
    await db.refresh(assignment)
    return _staff_assignment_response(assignment)


@router.delete("/{event_id}/checkin/staff/{staff_user_id}")
async def remove_checkin_staff(
    event_id: uuid.UUID,
    staff_user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Disable event staff assignment (organizer/admin only)."""
    await _assert_checkin_access(
        db,
        event_id=event_id,
        current_user=current_user,
        allow_staff=False,
    )
    assignment_result = await db.execute(
        select(EventStaffAssignment).where(
            EventStaffAssignment.event_id == event_id,
            EventStaffAssignment.user_id == staff_user_id,
            EventStaffAssignment.is_active.is_(True),
        )
    )
    assignment = assignment_result.scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Staff assignment not found")

    assignment.is_active = False
    assignment.created_by = current_user.id
    await db.commit()
    return {"message": "Staff assignment removed"}
