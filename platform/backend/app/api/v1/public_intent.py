"""공개 랜딩 부속기능 수신 API(무료 RSVP·단체예약 문의) — 상세통합 트랙B U3.

go 공개 랜딩(`/e/<slug>`)의 RSVP·그룹부킹을 consumer 로 이식하기 위한 v2 공개 진입점.

인증 없음(공개). consumer 가 로그인 없이 제출한다. 봇방지는 게스트 주문 경로와 동일하게
`verify_behavior_token`(BOT_DETECTION_KEY 설정 시 X-Behavior-Token 검증, 미설정 dev/test 는 skip)
+ IP `rate_limit_general` 를 적용한다. 권한/식별은 오직 요청 이메일로 판정한다.

게이트: 주최자 opt-in(events.rsvp_enabled / events.group_booking_enabled, go→v2 write-through)
       이 false 이면 403. 존재하지 않거나 비공개 상태 이벤트는 404(enumeration 방지).

멱등/동시성:
  - RSVP: (event_id, email) UNIQUE 로 중복 신청을 원장에서 차단. 동시 2회 제출 시 한쪽은
    IntegrityError → 409(재신청)로 수렴(레이스 안전). 외부 호출 없음(순수 DB write, 커밋 1회).
  - 그룹부킹: 견적 리드이므로 중복 자체를 막지 않되(문의는 여러 번 가능), 저장·주최자 통지를
    한 커밋으로 확정한다. 통지는 DB 행(NotificationModel) 이므로 외부 발송 아님(트랜잭션 안전).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.deps import verify_behavior_token
from app.core.database import get_db
from app.core.errors import ErrorCode, api_error
from app.middleware.rate_limit import rate_limit_general
from app.models.event import Event, EventStatus
from app.models.notification import NotificationModel
from app.models.public_intent import GroupBookingRequest, RsvpRegistration

logger = logging.getLogger(__name__)
router = APIRouter()

# 공개 노출(제출 허용) 이벤트 상태 — draft/취소 등 비공개 상태에는 제출 불가(404 위장).
_SUBMITTABLE_STATUSES = {
    EventStatus.APPROVED,
    EventStatus.BIDDING_OPEN,
    EventStatus.BIDDING_CLOSED,
    EventStatus.ALLOCATING,
    EventStatus.ALLOCATED,
    EventStatus.COMPLETED,
}


async def _load_submittable_event(db: AsyncSession, event_id: uuid.UUID) -> Event:
    """공개 제출 대상 이벤트 로드. 미존재/비공개 상태는 동일 404(enumeration 방지)."""
    event = (
        await db.execute(select(Event).where(Event.id == event_id))
    ).scalar_one_or_none()
    if event is None or event.status not in _SUBMITTABLE_STATUSES:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)
    return event


# ════════════════════════════════════════════════════════════════════════
# 요청 스키마
# ════════════════════════════════════════════════════════════════════════

class RsvpCreateRequest(BaseModel):
    event_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=200)
    email: EmailStr
    phone: str | None = Field(None, max_length=40)


class GroupBookingCreateRequest(BaseModel):
    # consumer 는 org_name/product_id 어휘를, go 는 organization_name/tier_id 어휘를 쓴다.
    # 양측 호환을 위해 AliasChoices 로 둘 다 수용(populate_by_name — 필드명 직접도 허용).
    model_config = ConfigDict(populate_by_name=True)

    event_id: uuid.UUID
    organization_name: str = Field(
        ...,
        min_length=2,
        max_length=200,
        validation_alias=AliasChoices("organization_name", "org_name"),
    )
    contact_name: str = Field(..., min_length=2, max_length=200)
    contact_email: EmailStr
    contact_phone: str | None = Field(None, max_length=40)
    attendee_count: int = Field(..., ge=2, le=100000)
    # 희망 등급 — consumer 는 product_id, go 는 tier_id 로 부른다(둘 다 v2 seat_tiers.id).
    tier_id: uuid.UUID | None = Field(
        None, validation_alias=AliasChoices("tier_id", "product_id")
    )
    notes: str | None = Field(None, max_length=2000)


# ════════════════════════════════════════════════════════════════════════
# 1) 무료 참석(RSVP) 수신 (공개 진입점)
# ════════════════════════════════════════════════════════════════════════

@router.post("/rsvp", summary="공개 무료 참석(RSVP) 신청 — opt-in 게이트 + 봇방지")
async def create_rsvp(
    body: RsvpCreateRequest,
    request: Request,
    _bot: None = Depends(verify_behavior_token),
    _rl: None = Depends(rate_limit_general),
    db: AsyncSession = Depends(get_db),
):
    """무료 참석(RSVP) 의향 신청.

    인증 없음(공개). rsvp_enabled=false → 403. 동일 이메일 재신청 → 409.
    응답: { registration_id, status: 'confirmed', message }.
    """
    event = await _load_submittable_event(db, body.event_id)
    if not event.rsvp_enabled:
        # 주최자 opt-in 미허용 — RSVP 미지원 이벤트.
        raise HTTPException(status_code=403, detail="이 이벤트는 참석 등록(RSVP)을 지원하지 않습니다.")

    normalized_email = str(body.email).lower()

    # 중복 사전차단(빠른 실패). 동시성은 아래 UNIQUE + IntegrityError 로 최종 보장.
    existing = (
        await db.execute(
            select(RsvpRegistration.id).where(
                RsvpRegistration.event_id == event.id,
                RsvpRegistration.email == normalized_email,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="이미 참석 등록하셨습니다.")

    reg = RsvpRegistration(
        event_id=event.id,
        name=body.name,
        email=normalized_email,
        phone=body.phone,
        status="confirmed",
    )
    db.add(reg)
    try:
        await db.commit()
    except IntegrityError:
        # 동시 2회 제출 레이스 — UNIQUE(event_id,email) 위반. 한쪽만 성공, 나머지는 409로 수렴.
        await db.rollback()
        raise HTTPException(status_code=409, detail="이미 참석 등록하셨습니다.")

    return {
        "registration_id": str(reg.id),
        "status": "confirmed",
        "message": "참석이 확인되었습니다!",
    }


# ════════════════════════════════════════════════════════════════════════
# 2) 단체 예약 문의 수신 (공개 진입점) + 주최자 통지
# ════════════════════════════════════════════════════════════════════════

@router.post("/group-bookings", summary="공개 단체 예약 문의 — opt-in 게이트 + 봇방지 + 주최자 통지")
async def create_group_booking(
    body: GroupBookingCreateRequest,
    request: Request,
    _bot: None = Depends(verify_behavior_token),
    _rl: None = Depends(rate_limit_general),
    db: AsyncSession = Depends(get_db),
):
    """단체 예약 문의(견적 리드) 접수.

    인증 없음(공개). group_booking_enabled=false → 403.
    저장 + 주최자 통지(NotificationModel, DB 행 — 외부 발송 아님)를 한 커밋으로 확정.
    응답: { booking_id, status: 'pending', message }.
    """
    event = await _load_submittable_event(db, body.event_id)
    if not event.group_booking_enabled:
        raise HTTPException(status_code=403, detail="이 이벤트는 단체 예약을 지원하지 않습니다.")

    booking = GroupBookingRequest(
        event_id=event.id,
        organization_name=body.organization_name,
        contact_name=body.contact_name,
        contact_email=str(body.contact_email).lower(),
        contact_phone=body.contact_phone,
        attendee_count=body.attendee_count,
        tier_id=body.tier_id,
        notes=body.notes,
        status="pending",
    )
    db.add(booking)
    await db.flush()  # booking.id 확보(통지 data 링크용).

    # 주최자 통지 — event.organizer_id(주최자 user id) 앞으로 인앱 통지 행 적재.
    # NotificationModel 은 DB 행이므로 이 커밋 안에 포함(외부 발송 아님 → 트랜잭션 경계 안전).
    notification = NotificationModel(
        user_id=event.organizer_id,
        event_id=event.id,
        type="group_booking_request",
        message=(
            f"[{event.title}] 단체 예약 문의: {body.organization_name} "
            f"({body.attendee_count}명)"
        ),
        data={
            "booking_id": str(booking.id),
            "event_id": str(event.id),
            "organization_name": body.organization_name,
            "contact_name": body.contact_name,
            "contact_email": booking.contact_email,
            "attendee_count": body.attendee_count,
        },
    )
    db.add(notification)
    await db.commit()

    return {
        "booking_id": str(booking.id),
        "status": "pending",
        "message": "단체 예약 신청이 접수되었습니다. 담당자가 확인 후 연락드리겠습니다.",
    }
