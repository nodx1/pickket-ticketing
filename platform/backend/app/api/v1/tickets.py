"""Ticket viewing endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.requests import Request

from app.core.config import settings
from app.core.database import get_db, get_read_db
from app.core.errors import api_error, ErrorCode
from app.core.redis import cache_get_json, cache_set_json, cache_delete_pattern
from app.middleware.auth import get_current_user
from app.models.event import Event
from app.models.event_staff import EventStaffAssignment
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.schemas.nft import NfcBindRequest, NfcTicketLookupResponse
from app.schemas.ticket import TicketListResponse, TicketQrResponse, TicketResponse
from app.services.admission_service import AdmissionError, admit
from app.services.dynamic_qr_service import generate_qr, TOTPQRService, verify_qr
from app.services.nfc_service import NfcService
from app.models.organizer_team import OrganizerTeamMember
from datetime import datetime, timezone as _tz
from pydantic import BaseModel

router = APIRouter()
DEVICE_BINDING_COOKIE_NAME = "__Host-pickket_device_binding"
DEVICE_BINDING_COOKIE_DEV_NAME = "pickket_device_binding"


async def _get_owned_ticket(
    db: AsyncSession,
    *,
    ticket_id: uuid.UUID,
    user_id: uuid.UUID,
) -> Ticket:
    result = await db.execute(
        select(Ticket)
        .options(selectinload(Ticket.event), selectinload(Ticket.tier))
        .where(Ticket.id == ticket_id)
    )
    ticket = result.scalars().first()
    if not ticket or ticket.current_owner_id != user_id:
        raise api_error(ErrorCode.TICKET_NOT_FOUND)
    return ticket


async def _assert_nfc_lookup_access(
    db: AsyncSession,
    *,
    ticket: Ticket,
    user: User,
) -> None:
    event = await db.get(Event, ticket.event_id)
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    if user.is_admin or event.organizer_id == user.id:
        return

    staff_result = await db.execute(
        select(EventStaffAssignment).where(
            EventStaffAssignment.event_id == ticket.event_id,
            EventStaffAssignment.user_id == user.id,
            EventStaffAssignment.is_active.is_(True),
        )
    )
    if staff_result.scalar_one_or_none():
        return

    raise HTTPException(status_code=403, detail="Organizer, staff, or admin access required")


@router.get(
    "/my",
    response_model=TicketListResponse,
    summary="내 티켓 목록",
    description="현재 로그인한 사용자가 소유한 모든 티켓을 페이지네이션으로 조회합니다. 이벤트 및 등급 정보가 포함됩니다.",
    openapi_extra={"x-agent-hint": "Auth required. Query params: skip (default 0), limit (default 50, max 100). Returns tickets with joined event and tier info."},
)
async def my_tickets(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get all tickets owned by the current user."""
    # Redis cache (60s TTL)
    cache_key = f"tickets:my:{user.id}:{skip}:{limit}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        return cached

    count_result = await db.execute(
        select(func.count(Ticket.id)).where(Ticket.current_owner_id == user.id)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(Ticket)
        .options(selectinload(Ticket.event), selectinload(Ticket.tier))
        .where(Ticket.current_owner_id == user.id)
        .order_by(Ticket.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    tickets = result.scalars().all()

    response = TicketListResponse(
        tickets=[TicketResponse.model_validate(t) for t in tickets],
        total=total,
    )
    await cache_set_json(cache_key, response.model_dump(mode="json"), ttl=60)
    return response


@router.get(
    "/{ticket_id}",
    response_model=TicketResponse,
    summary="티켓 상세 조회",
    description="티켓 ID로 상세 정보를 조회합니다. 본인 소유 티켓만 조회 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Pass ticket_id UUID. Returns TicketResponse with event/tier details. 403 if not ticket owner."},
)
async def get_ticket(
    ticket_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get a single ticket by ID. Must be owned by the current user."""
    ticket = await _get_owned_ticket(db, ticket_id=ticket_id, user_id=user.id)
    return TicketResponse.model_validate(ticket)


@router.get(
    "/{ticket_id}/qr",
    response_model=TicketQrResponse,
    summary="티켓 QR 코드 발급",
    description="활성 상태 티켓의 동적 QR 코드 페이로드를 발급합니다. TOTP 모드에서는 15초마다 갱신되며, 기본 모드에서는 설정된 만료 시간이 적용됩니다.",
    openapi_extra={"x-agent-hint": "Auth required. Only ACTIVE tickets can issue QR. Returns qr_data string and expires_in_seconds. Auto-binds device on first request."},
)
async def get_ticket_qr(
    ticket_id: uuid.UUID,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Issue a short-lived dynamic QR payload for active ticket entry."""
    ticket = await _get_owned_ticket(db, ticket_id=ticket_id, user_id=user.id)
    if ticket.status != TicketStatus.ACTIVE:
        raise api_error(ErrorCode.TICKET_NOT_ACTIVE, "Only active tickets can issue QR")

    # TOTP 시드가 없으면 자동 생성 (최초 QR 요청 시)
    if settings.TOTP_ENABLED and not ticket.totp_seed:
        ticket.totp_seed = TOTPQRService.generate_seed()
        await db.flush()

    if settings.TOTP_ENABLED and ticket.totp_seed:
        user_agent = request.headers.get("user-agent", "")
        screen_info = request.headers.get("x-screen-info", "unknown")
        timezone = request.headers.get("x-timezone", "unknown")
        # AUDIT §13 P0: SecureStore 디바이스 ID (스푸핑 저항성 주 secret)
        device_id = request.headers.get("x-device-id", "")
        cookie_name = (
            DEVICE_BINDING_COOKIE_NAME
            if settings.REFRESH_COOKIE_SECURE
            else DEVICE_BINDING_COOKIE_DEV_NAME
        )
        binding_secret = request.cookies.get(cookie_name) or TOTPQRService.generate_device_binding_secret()
        if request.cookies.get(cookie_name) != binding_secret:
            response.set_cookie(
                key=cookie_name,
                value=binding_secret,
                httponly=True,
                secure=settings.REFRESH_COOKIE_SECURE,
                samesite="lax",
                path="/",
            )

        # Auto-bind device on first QR request using server-issued binding secret + client device_id
        if not ticket.device_hash:
            ticket.device_hash = TOTPQRService.compute_device_hash(
                user_agent,
                screen_info,
                timezone,
                binding_secret=binding_secret,
                device_id=device_id,
            )
        elif not TOTPQRService.matches_device_hash(
            ticket.device_hash,
            user_agent,
            screen_info,
            timezone,
            binding_secret=binding_secret,
            device_id=device_id,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This ticket is bound to another device. Rebind is required.",
            )
        await db.commit()

        # Server-side QR generation — seed NEVER leaves the server
        qr_data = TOTPQRService.generate_qr_payload(
            ticket_id=str(ticket.id),
            seed=ticket.totp_seed,
            device_hash=ticket.device_hash,
        )
        return TicketQrResponse(
            ticket_id=ticket.id,
            qr_data=qr_data,
            expires_in_seconds=TOTPQRService.INTERVAL,
        )

    # AUDIT §25 P0: QR 도메인 전용 시크릿 (SECRET_KEY 공유 제거)
    qr_data = generate_qr(ticket.id, settings.QR_HMAC_SECRET)
    expires_in = settings.CHECKIN_QR_MAX_AGE_SECONDS

    return TicketQrResponse(
        ticket_id=ticket.id,
        qr_data=qr_data,
        expires_in_seconds=expires_in,
    )


@router.post(
    "/{ticket_id}/nfc-bind",
    response_model=NfcTicketLookupResponse,
    summary="NFC 바인딩",
    description="티켓에 NFC UID를 바인딩합니다. 현장 입장용 NFC 태그와 티켓을 연결합니다.",
    openapi_extra={"x-agent-hint": "Auth required. POST NfcBindRequest with nfc_uid. Only ticket owner can bind. One NFC per ticket."},
)
async def bind_ticket_nfc(
    ticket_id: uuid.UUID,
    body: NfcBindRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bind an NFC UID to the current user's ticket."""
    ticket = await _get_owned_ticket(db, ticket_id=ticket_id, user_id=user.id)
    service = NfcService(db)
    try:
        ticket = await service.bind_nfc(ticket.id, body.nfc_uid)
        await db.commit()
        return NfcTicketLookupResponse(
            ticket_id=ticket.id,
            event_id=ticket.event_id,
            tier_id=ticket.tier_id,
            current_owner_id=ticket.current_owner_id,
            status=ticket.status.value,
            nfc_uid=ticket.nfc_uid,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="NFC 등록 요청이 올바르지 않습니다.") from exc


@router.get(
    "/by-nfc/{nfc_uid}",
    response_model=NfcTicketLookupResponse,
    summary="NFC로 티켓 조회",
    description="NFC UID로 티켓을 조회합니다. 주최자, 스태프, 관리자만 접근 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required (organizer/staff/admin). Lookup ticket by NFC UID path param. Returns ticket info for on-site operations."},
)
async def get_ticket_by_nfc(
    nfc_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Look up a ticket by NFC UID for on-site operations."""
    service = NfcService(db)
    ticket = await service.lookup_by_nfc(nfc_uid)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found for NFC UID")
    await _assert_nfc_lookup_access(db, ticket=ticket, user=user)
    return NfcTicketLookupResponse(
        ticket_id=ticket.id,
        event_id=ticket.event_id,
        tier_id=ticket.tier_id,
        current_owner_id=ticket.current_owner_id,
        status=ticket.status.value,
        nfc_uid=ticket.nfc_uid,
    )


@router.post("/{ticket_id}/bind-device")
async def bind_device(
    ticket_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bind a device to a ticket for TOTP verification. One-time only."""
    if not settings.TOTP_ENABLED:
        raise HTTPException(status_code=501, detail="TOTP not enabled")

    ticket = await db.get(Ticket, ticket_id)
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if str(ticket.current_owner_id) != str(current_user.id):
        raise HTTPException(status_code=403, detail="Not your ticket")
    if ticket.device_hash:
        raise HTTPException(status_code=409, detail="Device already bound")

    body = await request.json()
    user_agent = request.headers.get("user-agent", "")
    screen_info = request.headers.get("x-screen-info") or body.get("screen_info", "unknown")
    timezone = request.headers.get("x-timezone") or body.get("timezone", "unknown")
    # AUDIT §13 P0: SecureStore 디바이스 ID 포함 (스푸핑 저항성)
    device_id = request.headers.get("x-device-id") or body.get("device_id", "")
    cookie_name = (
        DEVICE_BINDING_COOKIE_NAME
        if settings.REFRESH_COOKIE_SECURE
        else DEVICE_BINDING_COOKIE_DEV_NAME
    )
    binding_secret = request.cookies.get(cookie_name) or TOTPQRService.generate_device_binding_secret()
    response.set_cookie(
        key=cookie_name,
        value=binding_secret,
        httponly=True,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )

    device_hash = TOTPQRService.compute_device_hash(
        user_agent,
        screen_info,
        timezone,
        binding_secret=binding_secret,
        device_id=device_id,
    )
    ticket.device_hash = device_hash

    await db.commit()

    return {"bound": True, "ticket_id": str(ticket_id)}


# ──────────────────────────────────────────────────────────────────────────
# QR Check-in (현장 입장 검증)
# ──────────────────────────────────────────────────────────────────────────


class ValidateQRRequest(BaseModel):
    qr_payload: str


class ValidateQRResponse(BaseModel):
    status: str  # "ok" | "already_used" | "invalid"
    message: str
    ticket_id: str | None = None
    attendee_name: str | None = None
    event_title: str | None = None
    tier_name: str | None = None
    seat_label: str | None = None
    checked_in_at: datetime | None = None
    # F1 (cross-request): 다일 입장 계약 확장 — go/app 이 admission_mode·attended_date 를 인지.
    admission_mode: str | None = None
    attended_date: str | None = None  # KST 로컬 date (YYYY-MM-DD)
    # §13 당일 재입장(cross-request): admitted | reentry_ok | rejected.
    # status 만으로 '차단'과 '재입장 허용(당일 재스캔)'을 구분 못 하는 문제 해소(초록/빨강 UI 근거).
    outcome: str | None = None


@router.post(
    "/validate-qr",
    response_model=ValidateQRResponse,
    summary="현장 QR 스캔 입장 검증",
    description=(
        "스태프(주최자 또는 admin)가 현장에서 사용자의 QR 코드를 스캔하면 "
        "이 endpoint 가 검증하고 입장 처리합니다. 중복 스캔은 already_used 반환."
    ),
)
async def validate_qr(
    data: ValidateQRRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 1) QR HMAC 디코드 (60초 freshness)
    ticket_id = verify_qr(data.qr_payload, settings.QR_HMAC_SECRET, max_age_seconds=60)
    if ticket_id is None:
        return ValidateQRResponse(status="invalid", message="QR 코드가 만료되었거나 위조되었습니다")

    # 2) 티켓 + 이벤트 + tier + seat join
    from app.models.event import Event as _Event
    from app.models.event import SeatTier as _SeatTier
    from app.models.seat import Seat as _Seat
    row = (await db.execute(
        select(Ticket, _Event, _SeatTier, _Seat, User)
        .join(_Event, _Event.id == Ticket.event_id)
        .join(_SeatTier, _SeatTier.id == Ticket.tier_id)
        .outerjoin(_Seat, _Seat.id == Ticket.seat_id)
        .join(User, User.id == Ticket.current_owner_id)
        .where(Ticket.id == ticket_id)
    )).first()
    if not row:
        return ValidateQRResponse(status="invalid", message="티켓을 찾을 수 없습니다")
    ticket, event, tier, seat, owner = row

    # 3) 권한 — admin 이거나 이벤트 organizer 또는 organizer_team_members
    authorized = user.is_admin or event.organizer_id == user.id
    if not authorized:
        team = (await db.execute(
            select(OrganizerTeamMember.id).where(
                OrganizerTeamMember.user_id == user.id,
                OrganizerTeamMember.organizer_id == event.organizer_id,
            )
        )).scalar_one_or_none()
        authorized = team is not None
    if not authorized:
        raise HTTPException(status_code=403, detail="이 이벤트의 스태프 권한이 없습니다")

    # 4) 입장 판정 — F1: admit()/event_admissions 로 멱등·다일 일원화.
    #    (기존 attendances 스칼라 멱등 제거 — allpass 2일차 오판/다일 붕괴 해소.)
    now = datetime.now(_tz.utc)
    admission_mode = (getattr(event, "admission_mode", None) or "single")
    try:
        result = await admit(db, ticket, event, now, checked_in_by=user.id, method="qr_scan")
    except AdmissionError as e:
        # 취소/만료 또는 입장일 아님 → invalid(=실제 차단, 빨강). outcome=rejected.
        await db.rollback()
        return ValidateQRResponse(
            status="invalid",
            message=e.message,
            ticket_id=str(ticket_id),
            admission_mode=admission_mode,
            outcome="rejected",
        )

    await db.commit()

    if result.already:
        # 당일 재스캔 = 재입장 허용(점심·주차 반복출입). already_used 이지만 차단 아님(초록).
        return ValidateQRResponse(
            status="already_used",
            message=f"오늘 이미 입장한 티켓입니다 · 재입장 가능 ({result.admission.checked_in_at.strftime('%H:%M:%S')})",
            ticket_id=str(ticket_id),
            attendee_name=owner.name,
            event_title=event.title,
            tier_name=tier.name,
            seat_label=seat.label if seat else None,
            checked_in_at=result.admission.checked_in_at,
            admission_mode=admission_mode,
            attended_date=result.attended_date.isoformat(),
            outcome=result.outcome,  # reentry_ok
        )

    return ValidateQRResponse(
        status="ok",
        message="입장 처리 완료",
        ticket_id=str(ticket_id),
        attendee_name=owner.name,
        event_title=event.title,
        tier_name=tier.name,
        seat_label=seat.label if seat else None,
        checked_in_at=result.admission.checked_in_at,
        admission_mode=admission_mode,
        attended_date=result.attended_date.isoformat(),
        outcome=result.outcome,  # admitted
    )
