"""레벨2 W5-SUPPORT — 문의·게시심사·알림·용량·파이널콜·제휴생성 내부 API.

go DB 완전 제거 컷오버. go 에만 있던 지원(support) 계열 원장의 조회·변경 진입점을 v2 로 옮긴다.

  go `notifications`(조직자)   → v2 `organizer_notifications` (모델은 orgmsg_0724 에 이미 존재.
                                  **조회/변경 엔드포인트가 0** 이었어서 여기서 신설)
  go `event_reviews`           → v2 `event_publication_reviews`
  go `event_inquiries`         → v2 `event_inquiries`
  go `capacity_assignments`    → v2 `capacity_assignments`
  go `final_call_rules`        → v2 `final_call_rules`
  go `affiliates`(앵커 write)  → 원자 생성 엔드포인트로 대체(아래 §F)

## 🔴 fail-closed 규약 (이 파일 전체)
- 내부 오류를 "빈 목록"·"0건"·"404"로 위장하지 않는다. 조회 실패는 5xx 로 올라가고
  go 라우트가 503(재시도 가능)으로 번역한다.
- 특히 **게시 심사 이력**은 이벤트 공개 여부를 좌우한다. 조회 실패를 승인으로도 반려로도
  흘리면 안 된다(미심사 이벤트 공개 / 정당한 이벤트 차단). 모름은 모름으로 올린다.
- 삭제(DELETE)는 "조회 실패 → 이미 없음 → 200" 으로 흡수하지 않는다.

## 🔴 테넌트 경계 (Critical)
go 의 `AND account_id = $N` 가 사라진 자리를 **`events.organizer_id`** 가 대신한다.
이벤트 스코프 원장(심사·문의·용량·파이널콜)의 모든 조회·변경은 `_owned_event()` 를 먼저
통과해야 한다. 소유 불일치는 존재를 노출하지 않도록 404 로 투영한다.
`organizer_notifications` 만은 이벤트가 아니라 **account 스코프**라 `account_id` 가 직접 경계다
(go `session.accountId` 를 그대로 넘긴다 — 모든 쿼리에 조건 필수).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _commit_or_conflict,
    _err,
    _internal_auth,
    _ok,
    _READ_CACHE_CONTROL,
    _require_event,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.affiliate import Affiliate
from app.models.event import Event, SeatTier
from app.models.organizer_messaging import ORGANIZER_NOTIFICATION_TYPES, OrganizerNotification
from app.models.organizer_support import (
    CapacityAssignment,
    EventInquiry,
    EventPublicationReview,
    FinalCallRule,
    PUBLICATION_REVIEW_ACTIONS,
    EVENT_INQUIRY_SOURCES,
    EVENT_INQUIRY_STATUSES,
)

router = APIRouter(dependencies=[Depends(_internal_auth)])

# 목록 상한 — 무제한 조회로 DB 를 태우는 경로 차단(go LIMIT 200/20 계승).
_MAX_INQUIRY_LIMIT = 200
_MAX_REVIEW_LIMIT = 100
_MAX_NOTIFICATION_LIMIT = 100


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_org_ref(ref: str) -> OrganizerRef:
    """organizer_ref 문자열 파싱 — internal_hosts._parse_org_ref 와 동일 규약(원본 수정 금지)."""
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except ValueError:
        return OrganizerRef(go_account_id=ref)


async def _owned_event(db: AsyncSession, event_id: uuid.UUID, organizer_ref: str) -> Event:
    """이벤트 소유 검증 — 이 파일의 이벤트 스코프 경로가 **반드시** 먼저 통과하는 관문.

    go 의 `AND account_id = $N` 를 대체한다. 미존재/타 organizer 소유를 구분하지 않고 404 로
    투영해 존재 사실을 노출하지 않는다(go 기존 계약과 동일).
    """
    organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    event = await _require_event(db, event_id)
    if event.organizer_id != organizer_id:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    return event


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ═════════════════════════════════════════════════════════════════════════════
# A. 조직자 알림 (go notifications → v2 organizer_notifications)
#    account 스코프 — 이벤트 소유 검증이 아니라 account_id 가 경계다.
# ═════════════════════════════════════════════════════════════════════════════


def _notification_out(n: OrganizerNotification) -> dict:
    return {
        "id": str(n.id),
        "account_id": str(n.account_id),
        "event_id": str(n.event_id) if n.event_id else None,
        "type": n.type,
        "title": n.title,
        "message": n.message,
        "is_read": bool(n.is_read),
        "metadata": n.notif_metadata or {},
        "created_at": _iso(n.created_at),
    }


class NotificationCreateRequest(BaseModel):
    account_id: uuid.UUID
    event_id: uuid.UUID | None = None
    type: str = Field(..., min_length=1, max_length=40)
    title: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    metadata: dict | None = None


class AccountScopeRequest(BaseModel):
    account_id: uuid.UUID


@router.get("/organizer-notifications/unread-count", summary="go read: 미읽음 알림 수")
async def organizer_notifications_unread_count(
    account_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    count = (
        await db.execute(
            select(func.count())
            .select_from(OrganizerNotification)
            .where(
                OrganizerNotification.account_id == account_id,
                OrganizerNotification.is_read.is_(False),
            )
        )
    ).scalar_one()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"count": int(count)})


@router.get("/organizer-notifications", summary="go read: 조직자 알림 목록(페이지네이션)")
async def list_organizer_notifications(
    account_id: uuid.UUID,
    request: Request,
    response: Response,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=_MAX_NOTIFICATION_LIMIT),
    unread_only: bool = False,
    db: AsyncSession = Depends(get_db),
):
    # 🔴 account_id 조건은 두 쿼리 모두에 들어간다(목록/총계 어느 한쪽만 빠져도 누출·오표기).
    conds = [OrganizerNotification.account_id == account_id]
    if unread_only:
        conds.append(OrganizerNotification.is_read.is_(False))

    total = (
        await db.execute(select(func.count()).select_from(OrganizerNotification).where(*conds))
    ).scalar_one()
    rows = (
        (
            await db.execute(
                select(OrganizerNotification)
                .where(*conds)
                .order_by(OrganizerNotification.created_at.desc())
                .limit(limit)
                .offset((page - 1) * limit)
            )
        )
        .scalars()
        .all()
    )
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(
        {
            "items": [_notification_out(n) for n in rows],
            "total": int(total),
            "page": page,
            "limit": limit,
        }
    )


@router.post("/organizer-notifications", summary="go write: 조직자 알림 생성")
async def create_organizer_notification(
    request: Request,
    body: NotificationCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        if body.type not in ORGANIZER_NOTIFICATION_TYPES:
            # 🔴 알 수 없는 type 을 조용히 통과시키면 DB CHECK 에서 500 으로 터진다.
            #    허용 목록을 벗어난 값은 명시적 400 으로 되돌려 호출측이 즉시 인지하게 한다.
            raise ApiError(
                "VALIDATION_ERROR", f"unsupported notification type: {body.type}", 400, "type"
            )
        n = OrganizerNotification(
            account_id=body.account_id,
            event_id=body.event_id,
            type=body.type,
            title=body.title,
            message=body.message,
            is_read=False,
            notif_metadata=body.metadata or {},
        )
        db.add(n)
        await _commit_or_conflict(db, "organizer notification")
        return _ok({"id": str(n.id)})
    except ApiError as e:
        return _err(e)


@router.patch("/organizer-notifications/read-all", summary="go write: 전체 읽음 처리")
async def mark_all_organizer_notifications_read(
    request: Request,
    body: AccountScopeRequest,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        update(OrganizerNotification)
        .where(
            OrganizerNotification.account_id == body.account_id,
            OrganizerNotification.is_read.is_(False),
        )
        .values(is_read=True)
    )
    await db.commit()
    return _ok({"updated": int(result.rowcount or 0)})


@router.patch("/organizer-notifications/{notification_id}/read", summary="go write: 단건 읽음")
async def mark_organizer_notification_read(
    notification_id: uuid.UUID,
    request: Request,
    body: AccountScopeRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        # 🔴 account_id 를 WHERE 에 반드시 포함 — 없으면 남의 알림을 읽음 처리할 수 있다.
        result = await db.execute(
            update(OrganizerNotification)
            .where(
                OrganizerNotification.id == notification_id,
                OrganizerNotification.account_id == body.account_id,
            )
            .values(is_read=True)
        )
        if not result.rowcount:
            await db.rollback()
            raise ApiError("NOTIFICATION_NOT_FOUND", f"notification not found: {notification_id}", 404)
        await db.commit()
        return _ok({"updated": True})
    except ApiError as e:
        return _err(e)


@router.delete("/organizer-notifications/{notification_id}", summary="go write: 알림 삭제")
async def delete_organizer_notification(
    notification_id: uuid.UUID,
    account_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        n = (
            await db.execute(
                select(OrganizerNotification).where(
                    OrganizerNotification.id == notification_id,
                    OrganizerNotification.account_id == account_id,
                )
            )
        ).scalar_one_or_none()
        if n is None:
            # 진짜 미존재/타 계정만 404. DB 장애는 예외로 전파돼 5xx 가 된다(멱등 흡수 금지).
            raise ApiError("NOTIFICATION_NOT_FOUND", f"notification not found: {notification_id}", 404)
        await db.delete(n)
        await db.commit()
        return _ok({"deleted": True})
    except ApiError as e:
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# B. 게시 심사 원장 (go event_reviews → v2 event_publication_reviews)
#
# 🔴 v2 `reviews`(관람객 후기)와 **다른 테이블**이다. 절대 섞지 않는다.
# ═════════════════════════════════════════════════════════════════════════════


class PublicationReviewCreateRequest(BaseModel):
    """심사 이력 기록.

    `organizer_ref` 는 **선택**이다:
      - 주최자 submit 경로(go `PATCH /events/{id}` status=pending_review)는 organizer_ref 를 주고
        소유 검증을 받는다.
      - 어드민 승인/반려 경로(go `v2-webhook/.../review-result`)는 admin 발신이라 organizer 스코프가
        없다 — 이때는 이벤트 존재만 확인한다(이 API 자체가 내부 서비스 인증 뒤에 있다).
    """

    organizer_ref: str | OrganizerRef | None = None
    action: str
    reason: str | None = None
    checklist: dict | None = None
    reviewer_ref: str | None = Field(default=None, max_length=100)
    reviewer_name: str | None = Field(default=None, max_length=200)


def _review_out(r: EventPublicationReview) -> dict:
    return {
        "id": str(r.id),
        "action": r.action,
        "reason": r.reason,
        "checklist": r.checklist or {},
        "reviewer_ref": r.reviewer_ref,
        "reviewer_name": r.reviewer_name,
        "created_at": _iso(r.created_at),
    }


@router.get(
    "/events/{event_id}/publication-reviews", summary="go read: 게시 심사 이력(최신순)"
)
async def list_publication_reviews(
    event_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    limit: int = Query(20, ge=1, le=_MAX_REVIEW_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    try:
        # 🔴 go `event_reviews` 에는 account_id 가 없었고 `JOIN events` 가 유일한 경계였다.
        #    그 경계를 여기서 organizer_id 로 복원한다 — 빠지면 남의 반려 사유가 새 나간다.
        await _owned_event(db, event_id, organizer_ref)
    except ApiError as e:
        return _err(e)
    rows = (
        (
            await db.execute(
                select(EventPublicationReview)
                .where(EventPublicationReview.event_id == event_id)
                .order_by(EventPublicationReview.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"reviews": [_review_out(r) for r in rows], "total": len(rows)})


@router.post("/events/{event_id}/publication-reviews", summary="go write: 게시 심사 이력 기록")
async def create_publication_review(
    event_id: uuid.UUID,
    request: Request,
    body: PublicationReviewCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        if body.action not in PUBLICATION_REVIEW_ACTIONS:
            raise ApiError(
                "VALIDATION_ERROR", f"unsupported review action: {body.action}", 400, "action"
            )
        if body.organizer_ref is not None:
            ref = (
                body.organizer_ref
                if isinstance(body.organizer_ref, OrganizerRef)
                else _parse_org_ref(str(body.organizer_ref))
            )
            organizer_id = await _resolve_organizer(db, ref)
            event = await _require_event(db, event_id)
            if event.organizer_id != organizer_id:
                raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
        else:
            await _require_event(db, event_id)

        r = EventPublicationReview(
            event_id=event_id,
            action=body.action,
            reason=body.reason,
            checklist=body.checklist or {},
            reviewer_ref=body.reviewer_ref,
            reviewer_name=body.reviewer_name,
        )
        db.add(r)
        await _commit_or_conflict(db, "publication review")
        return _ok({"id": str(r.id)})
    except ApiError as e:
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# C. 소비자 문의 (go event_inquiries)
# ═════════════════════════════════════════════════════════════════════════════


class InquiryCreateRequest(BaseModel):
    """공개(비인증) 접수 — go `api/public/inquiries` 가 이벤트를 이미 해석한 뒤 호출한다.

    organizer_ref 가 없다(제출자는 소비자다). 이벤트 존재만 확인하고 저장한다.
    🔴 저장 실패는 반드시 예외로 올라가 go 가 5xx 로 번역한다 — 200 흡수 금지.
    """

    question: str = Field(..., min_length=1, max_length=4000)
    contact: str | None = Field(default=None, max_length=400)
    source: str = "web"


class InquiryPatchRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    status: str | None = None
    answer: str | None = Field(default=None, max_length=4000)


def _inquiry_out(i: EventInquiry) -> dict:
    """원문 contact 를 그대로 싣는다 — 마스킹은 go 표시 계층 책임(회신 발송에 원문이 필요)."""
    return {
        "id": str(i.id),
        "contact": i.contact,
        "question": i.question,
        "answer": i.answer,
        "status": i.status,
        "source": i.source,
        "category": i.category,
        "urgency": i.urgency,
        "created_at": _iso(i.created_at),
        "updated_at": _iso(i.updated_at),
    }


@router.get("/events/{event_id}/inquiries", summary="go read: 주최자 문의함")
async def list_event_inquiries(
    event_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    status: str | None = None,
    limit: int = Query(_MAX_INQUIRY_LIMIT, ge=1, le=_MAX_INQUIRY_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref)
        conds = [EventInquiry.event_id == event_id]
        if status is not None:
            if status not in EVENT_INQUIRY_STATUSES:
                raise ApiError("VALIDATION_ERROR", f"unsupported status: {status}", 400, "status")
            conds.append(EventInquiry.status == status)
    except ApiError as e:
        return _err(e)
    rows = (
        (
            await db.execute(
                select(EventInquiry)
                .where(*conds)
                .order_by(EventInquiry.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"inquiries": [_inquiry_out(i) for i in rows], "total": len(rows)})


@router.post("/events/{event_id}/inquiries", summary="공개 접수: 소비자 문의 저장")
async def create_event_inquiry(
    event_id: uuid.UUID,
    request: Request,
    body: InquiryCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        if body.source not in EVENT_INQUIRY_SOURCES:
            raise ApiError("VALIDATION_ERROR", f"unsupported source: {body.source}", 400, "source")
        await _require_event(db, event_id)
        i = EventInquiry(
            event_id=event_id,
            contact=(body.contact or "").strip() or None,
            question=body.question.strip(),
            status="open",
            source=body.source,
        )
        db.add(i)
        await _commit_or_conflict(db, "event inquiry")
        return _ok({"id": str(i.id)})
    except ApiError as e:
        return _err(e)


@router.patch("/events/{event_id}/inquiries/{inquiry_id}", summary="go write: 문의 상태/회신")
async def patch_event_inquiry(
    event_id: uuid.UUID,
    inquiry_id: uuid.UUID,
    request: Request,
    body: InquiryPatchRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        ref = (
            body.organizer_ref
            if isinstance(body.organizer_ref, OrganizerRef)
            else _parse_org_ref(str(body.organizer_ref))
        )
        organizer_id = await _resolve_organizer(db, ref)
        event = await _require_event(db, event_id)
        if event.organizer_id != organizer_id:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
        if body.status is not None and body.status not in EVENT_INQUIRY_STATUSES:
            raise ApiError("VALIDATION_ERROR", f"unsupported status: {body.status}", 400, "status")

        # 🔴 event_id 조건 유지 — inquiry_id 만으로 갱신하면 타 이벤트 문의를 건드릴 수 있다.
        i = (
            await db.execute(
                select(EventInquiry).where(
                    EventInquiry.id == inquiry_id, EventInquiry.event_id == event_id
                )
            )
        ).scalar_one_or_none()
        if i is None:
            raise ApiError("INQUIRY_NOT_FOUND", f"inquiry not found: {inquiry_id}", 404)

        if body.status is not None:
            i.status = body.status
        if body.answer is not None:
            i.answer = body.answer
        i.updated_at = _now()
        await _commit_or_conflict(db, "event inquiry")
        # go 는 갱신 후 원문 contact/question/answer 로 소비자 통지를 만든다 → 그대로 돌려준다.
        return _ok({"updated": True, "inquiry": _inquiry_out(i)})
    except ApiError as e:
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# D. 용량 배정 (go capacity_assignments)
# ═════════════════════════════════════════════════════════════════════════════


class CapacityUpsertRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    # go products.id == v2 seat_tiers.external_ref (W2-PS).
    product_ref: str = Field(..., min_length=1, max_length=100)
    capacity: int = Field(..., gt=0)
    used_capacity: int = Field(0, ge=0)


@router.get("/events/{event_id}/capacity-assignments", summary="go read: 용량 배정 목록")
async def list_capacity_assignments(
    event_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref)
    except ApiError as e:
        return _err(e)
    # go 는 `INNER JOIN products` 로 상품명을 붙이고 products.created_at 으로 정렬했다.
    # products 는 W2-PS 에서 v2 seat_tiers 로 흡수됐으므로 external_ref 로 조인한다.
    # 🔴 LEFT OUTER 로 바꾼다 — INNER 였다면 티어가 아직 동기화되지 않은 배정이 목록에서
    #    **조용히 사라진다**(주최자는 배정이 지워진 줄 안다). 이름만 null 로 두고 행은 남긴다.
    rows = (
        await db.execute(
            select(CapacityAssignment, SeatTier.name)
            .outerjoin(
                SeatTier,
                (SeatTier.external_ref == CapacityAssignment.product_ref)
                & (SeatTier.event_id == CapacityAssignment.event_id),
            )
            .where(CapacityAssignment.event_id == event_id)
            .order_by(SeatTier.sort_order.nulls_last(), CapacityAssignment.created_at)
        )
    ).all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(
        {
            "assignments": [
                {
                    "id": str(a.id),
                    "product_ref": a.product_ref,
                    "product_name": tier_name,
                    "capacity": int(a.capacity),
                    "used_capacity": int(a.used_capacity),
                    "status": a.status,
                }
                for a, tier_name in rows
            ],
            "total": len(rows),
        }
    )


@router.put("/events/{event_id}/capacity-assignments", summary="go write: 용량 배정 upsert")
async def upsert_capacity_assignment(
    event_id: uuid.UUID,
    request: Request,
    body: CapacityUpsertRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        ref = (
            body.organizer_ref
            if isinstance(body.organizer_ref, OrganizerRef)
            else _parse_org_ref(str(body.organizer_ref))
        )
        organizer_id = await _resolve_organizer(db, ref)
        event = await _require_event(db, event_id)
        if event.organizer_id != organizer_id:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

        existing = (
            await db.execute(
                select(CapacityAssignment).where(
                    CapacityAssignment.event_id == event_id,
                    CapacityAssignment.product_ref == body.product_ref,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.capacity = body.capacity
            existing.used_capacity = body.used_capacity
            existing.updated_at = _now()
            row = existing
        else:
            row = CapacityAssignment(
                event_id=event_id,
                product_ref=body.product_ref,
                capacity=body.capacity,
                used_capacity=body.used_capacity,
                status="active",
            )
            db.add(row)
        await _commit_or_conflict(db, "capacity assignment (event_id, product_ref)")
        return _ok({"id": str(row.id)})
    except ApiError as e:
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# E. 파이널콜 규칙 (go final_call_rules)
# ═════════════════════════════════════════════════════════════════════════════


class FinalCallRulePutRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    is_active: bool = False
    trigger_hours_before: int = Field(24, ge=1, le=720)
    discount_percent: int = Field(30, ge=5, le=80)
    min_remaining_percent: int = Field(20, ge=0, le=90)
    max_discount_tickets: int | None = Field(default=None, ge=1)
    notify_buyers: bool = True


def _rule_out(r: FinalCallRule | None) -> dict:
    """미설정 이벤트는 go 와 동일한 **기본값**을 돌려준다(폼 초기값).

    ⚠️ 이 기본값은 "설정이 없다"는 확정 사실에만 쓴다. 조회 자체가 실패하면 예외가 위로
       전파되므로 여기까지 오지 않는다(장애를 기본값으로 위장하지 않는다).
    """
    if r is None:
        return {
            "is_active": False,
            "trigger_hours_before": 24,
            "discount_percent": 30,
            "min_remaining_percent": 20,
            "max_discount_tickets": None,
            "notify_buyers": True,
        }
    return {
        "is_active": bool(r.is_active),
        "trigger_hours_before": int(r.trigger_hours_before),
        "discount_percent": int(r.discount_percent),
        "min_remaining_percent": int(r.min_remaining_percent),
        "max_discount_tickets": r.max_discount_tickets,
        "notify_buyers": bool(r.notify_buyers),
    }


@router.get("/events/{event_id}/final-call-rule", summary="go read: 파이널콜 규칙")
async def get_final_call_rule(
    event_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref)
    except ApiError as e:
        return _err(e)
    r = (
        await db.execute(select(FinalCallRule).where(FinalCallRule.event_id == event_id))
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"rule": _rule_out(r), "configured": r is not None})


@router.put("/events/{event_id}/final-call-rule", summary="go write: 파이널콜 규칙 upsert")
async def put_final_call_rule(
    event_id: uuid.UUID,
    request: Request,
    body: FinalCallRulePutRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        ref = (
            body.organizer_ref
            if isinstance(body.organizer_ref, OrganizerRef)
            else _parse_org_ref(str(body.organizer_ref))
        )
        organizer_id = await _resolve_organizer(db, ref)
        event = await _require_event(db, event_id)
        if event.organizer_id != organizer_id:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

        r = (
            await db.execute(select(FinalCallRule).where(FinalCallRule.event_id == event_id))
        ).scalar_one_or_none()
        if r is None:
            r = FinalCallRule(event_id=event_id)
            db.add(r)
        r.is_active = body.is_active
        r.trigger_hours_before = body.trigger_hours_before
        r.discount_percent = body.discount_percent
        r.min_remaining_percent = body.min_remaining_percent
        r.max_discount_tickets = body.max_discount_tickets
        r.notify_buyers = body.notify_buyers
        r.updated_at = _now()
        await _commit_or_conflict(db, "final call rule (event_id)")
        return _ok({"rule": _rule_out(r), "configured": True})
    except ApiError as e:
        return _err(e)


# ═════════════════════════════════════════════════════════════════════════════
# F. 제휴 원자 생성 (go affiliates 앵커 write 대체)
#
# 🔴 왜 기존 `PUT /events/{id}/affiliates`(배치 upsert)로 충분하지 않은가
#    `_do_upsert_affiliates` 는 **code 로 매칭**해 존재하면 덮어쓴다. go 는 그 앞에
#    `SELECT id FROM affiliates WHERE event_id=$1 AND code=$2` 로 중복을 걸러 409 를 냈는데,
#    go 앵커를 없애면서 그 사전검사를 v2 목록 조회로 옮기면 **TOCTOU** 가 생기고, 경합 시
#    "덮어쓰기"가 되어 **남의 제휴 정의(이름·수수료율·external_ref)를 조용히 가로챈다**.
#    → 생성 전용 엔드포인트를 두고 `uq_affiliates_event_code` 유니크 제약이 경합을 원자적으로
#      끊게 한다(중복 = 409). 기존 배치 upsert 는 손대지 않는다(타 트랙 사용 중).
# ═════════════════════════════════════════════════════════════════════════════


class AffiliateCreateRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    # go affiliate id — 상세/수정/삭제 라우트가 이 값으로 주소지정한다(external_ref).
    external_ref: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=200)
    code: str = Field(..., min_length=1, max_length=50)
    commission_rate: float = Field(0.0, ge=0, le=100)


@router.post("/events/{event_id}/affiliates", summary="go write: 제휴 원자 생성(중복코드 409)")
async def create_affiliate(
    event_id: uuid.UUID,
    request: Request,
    body: AffiliateCreateRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        ref = (
            body.organizer_ref
            if isinstance(body.organizer_ref, OrganizerRef)
            else _parse_org_ref(str(body.organizer_ref))
        )
        organizer_id = await _resolve_organizer(db, ref)
        event = await _require_event(db, event_id)
        if event.organizer_id != organizer_id:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

        aff = Affiliate(
            event_id=event_id,
            external_ref=body.external_ref,
            account_id=str(organizer_id),
            name=body.name,
            code=body.code,
            commission_rate=body.commission_rate,
            status="active",
        )
        db.add(aff)
        # uq_affiliates_event_code / ix_affiliates_external_ref 위반 → _Conflict(409).
        await _commit_or_conflict(db, "affiliate (event_id, code)")
        return _ok({"affiliate_id": str(aff.id), "external_ref": body.external_ref})
    except ApiError as e:
        return _err(e)
