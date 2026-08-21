"""레벨2 W5-CONTENT — 콘텐츠·표시 계열 내부 API (go DB 제거).

go 대시보드의 6개 화면(위젯 / 티켓 디자이너 / 브릿지 페이지 / 공개 공지 / 시설 / 출연진)이
go DB 대신 이 API 를 통해 v2 정본(`app/models/organizer_content.py`)을 읽고 쓴다.

## 경로 구성
  · `/internal/events/{event_id}/organizer-content/**`  — 주최자 스코프. `organizer_ref` **필수**.
  · `/internal/events/{event_id}/public-content/**`     — 공개 노출용. 인증된 서비스만 호출하며
    **공개 가능한 부분집합만** 내보낸다(발행 공지·위젯 설정·티켓 디자인).

## 🔴 이 파일이 지키는 3가지

1) **테넌트 경계는 event_id → events.organizer_id 단 한 곳**에서 강제한다(`_owned_event`).
   go 의 옛 `AND account_id = $2` 를 대체한다. 미소유/미존재는 구분 없이 404(존재 노출 금지).

2) **정본과 소비자 투영의 원자적 동기화.** 출연진/공지/시설은 편집할 때마다 같은 트랜잭션에서
   `event_mirror`(소비자 노출 투영)를 재작성한다. 투영에는 **공개 가능한 행만** 넣는다
   (출연진 is_visible=true / 공지 is_published=true / 시설은 내부필드 vendor·cost·notes 제외).
   같은 DB·같은 트랜잭션이라 외부호출도 아웃박스도 없다 — split-brain 이 구조적으로 불가능하다.

3) **동시 편집 직렬화.** 정본 편집 + 투영 재작성은 `events` 행 `FOR UPDATE` 로 이벤트 단위
   직렬화한다. 이게 없으면 A/B 동시 편집에서 오래된 스냅샷이 투영을 덮어써 최신 편집이 유실된다
   (go 가 pg_advisory_lock 으로 막던 것을 여기로 옮긴 것 — 이제 락과 write 가 같은 트랜잭션이다).
   SQLite(테스트)는 FOR UPDATE 를 렌더하지 않으므로 무해하다.

## 멱등
생성(POST)은 호출자가 `item_id`(UUID)를 만들어 보낸다. 네트워크 재시도로 같은 요청이 두 번
도착해도 같은 행을 갱신할 뿐 중복 행이 생기지 않는다("동시 2회 실행하면?"에 대한 답).
PUT(위젯/티켓디자인/브릿지)은 event_id 1:1 upsert 라 본래 멱등. DELETE 는 대상이 없으면
**404** 다 — 없는 것을 지웠다고 200 을 주면 호출자가 v2 장애를 "지웠다"로 오독한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _commit_or_conflict,
    _err,
    _internal_auth,
    _ok,
    _parse_iso,
    _READ_CACHE_CONTROL,
    _require_event,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.event import Event
from app.models.event_mirror import EventAnnouncement, EventFacility, EventParticipant
from app.models.organizer_content import (
    FACILITY_CATEGORIES,
    FACILITY_STATUSES,
    NOTICE_TYPES,
    PARTICIPANT_ROLES,
    WIDGET_MODES,
    OrganizerBridgePage,
    OrganizerEventFacility,
    OrganizerEventParticipant,
    OrganizerOpenNotice,
    OrganizerTicketDesign,
    OrganizerWidgetConfig,
)

router = APIRouter(dependencies=[Depends(_internal_auth)])

# 한 이벤트가 가질 수 있는 항목 수 상한. 투영 재작성이 매 편집마다 전량 rewrite 라
# 무제한이면 편집 1회의 비용이 선형으로 늘어난다. go UI 규모(수십 건) 대비 넉넉하다.
_MAX_ITEMS_PER_EVENT = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_org_ref(ref: str) -> OrganizerRef:
    """organizer_ref 문자열 파싱 — internal_hosts._parse_org_ref 와 동일 규약(원본 수정 금지)."""
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except ValueError:
        return OrganizerRef(go_account_id=ref)


async def _owned_event(
    db: AsyncSession, event_id: uuid.UUID, organizer_ref: str, *, lock: bool = False
) -> Event:
    """이벤트 소유 검증(테넌트 경계). 미존재·타 organizer 소유 모두 404 로 투영한다.

    lock=True 면 `FOR UPDATE` 로 이벤트 행을 잡아 같은 이벤트의 동시 편집을 직렬화한다.
    """
    organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    if lock:
        event = (
            await db.execute(select(Event).where(Event.id == event_id).with_for_update())
        ).scalar_one_or_none()
        if event is None:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    else:
        event = await _require_event(db, event_id)
    if event.organizer_id != organizer_id:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    return event


def _validate_enum(value: str | None, allowed: tuple[str, ...], field: str) -> None:
    if value is not None and value not in allowed:
        raise ApiError(
            "VALIDATION_ERROR", f"{field} must be one of {', '.join(allowed)}", 400, field
        )


async def _assert_capacity(db: AsyncSession, model, event_id: uuid.UUID) -> None:
    count = (
        await db.execute(
            select(func.count()).select_from(model).where(model.event_id == event_id)
        )
    ).scalar_one()
    if count >= _MAX_ITEMS_PER_EVENT:
        raise ApiError(
            "LIMIT_EXCEEDED",
            f"event already has the maximum number of items ({_MAX_ITEMS_PER_EVENT})",
            409,
        )


# ── 소비자 노출 투영 재작성 ───────────────────────────────────────────────
#   정본 편집과 **같은 트랜잭션**에서만 호출한다(커밋은 호출부가 한 번).


async def _reproject_participants(db: AsyncSession, event_id: uuid.UUID) -> None:
    """출연진 투영 = is_visible=true 만. 숨김 항목이 소비자에게 새면 안 된다."""
    await db.execute(delete(EventParticipant).where(EventParticipant.event_id == event_id))
    rows = (
        await db.execute(
            select(OrganizerEventParticipant)
            .where(
                OrganizerEventParticipant.event_id == event_id,
                OrganizerEventParticipant.is_visible.is_(True),
            )
            .order_by(OrganizerEventParticipant.sort_order)
        )
    ).scalars().all()
    for p in rows:
        db.add(
            EventParticipant(
                event_id=event_id,
                name=p.name,
                role=p.role,
                bio=p.bio,
                image_url=p.image_url,
                sort_order=p.sort_order,
            )
        )


async def _reproject_notices(db: AsyncSession, event_id: uuid.UUID) -> None:
    """공지 투영 = is_published=true 만. 미발행 초안이 소비자에게 새면 안 된다."""
    await db.execute(delete(EventAnnouncement).where(EventAnnouncement.event_id == event_id))
    rows = (
        await db.execute(
            select(OrganizerOpenNotice)
            .where(
                OrganizerOpenNotice.event_id == event_id,
                OrganizerOpenNotice.is_published.is_(True),
            )
            .order_by(OrganizerOpenNotice.created_at.desc())
        )
    ).scalars().all()
    for n in rows:
        db.add(
            EventAnnouncement(
                event_id=event_id,
                notice_type=n.notice_type,
                title=n.title,
                content=n.content,
                published_at=n.published_at,
            )
        )


async def _reproject_facilities(db: AsyncSession, event_id: uuid.UUID) -> None:
    """시설 투영 = 전 행이되 **내부 필드(vendor/cost/notes) 제외**. 거래처 단가 노출 금지."""
    await db.execute(delete(EventFacility).where(EventFacility.event_id == event_id))
    rows = (
        await db.execute(
            select(OrganizerEventFacility)
            .where(OrganizerEventFacility.event_id == event_id)
            .order_by(OrganizerEventFacility.category, OrganizerEventFacility.name)
        )
    ).scalars().all()
    for f in rows:
        db.add(
            EventFacility(
                event_id=event_id,
                name=f.name,
                category=f.category,
                quantity=f.quantity,
                status=f.status,
            )
        )


# ── 직렬화 ───────────────────────────────────────────────────────────────


def _participant_out(p: OrganizerEventParticipant) -> dict:
    return {
        "id": str(p.id),
        "event_id": str(p.event_id),
        "name": p.name,
        "role": p.role,
        "bio": p.bio,
        "image_url": p.image_url,
        "sort_order": int(p.sort_order or 0),
        "is_visible": bool(p.is_visible),
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _notice_out(n: OrganizerOpenNotice) -> dict:
    return {
        "id": str(n.id),
        "event_id": str(n.event_id),
        "notice_type": n.notice_type,
        "title": n.title,
        "content": n.content,
        "is_published": bool(n.is_published),
        "published_at": n.published_at.isoformat() if n.published_at else None,
        "created_at": n.created_at.isoformat() if n.created_at else None,
        "updated_at": n.updated_at.isoformat() if n.updated_at else None,
    }


def _facility_out(f: OrganizerEventFacility) -> dict:
    return {
        "id": str(f.id),
        "event_id": str(f.event_id),
        "name": f.name,
        "category": f.category,
        "quantity": int(f.quantity or 0),
        "status": f.status,
        "vendor": f.vendor,
        "cost": int(f.cost or 0),
        "notes": f.notes,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _widget_out(w: OrganizerWidgetConfig | None) -> dict:
    """위젯 설정. 행이 없으면 `configured=false` + go 기본값.

    🔴 `configured` 는 장식이 아니다. 호출측(공개 위젯 라우트)이 "설정이 실제로 없어서 비었다"
    와 "못 읽었다" 를 구분해야 허용 도메인 화이트리스트를 fail-open 시키지 않는다.
    못 읽은 경우는 이 함수까지 오지 않고 HTTP 에러로 끊긴다.
    """
    if w is None:
        return {
            "configured": False,
            "mode": "button",
            "theme": {},
            "allowed_domains": [],
            "is_active": True,
        }
    return {
        "configured": True,
        "mode": w.mode,
        "theme": w.theme or {},
        "allowed_domains": list(w.allowed_domains or []),
        "is_active": bool(w.is_active),
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


def _bridge_out(b: OrganizerBridgePage | None) -> dict:
    if b is None:
        return {
            "configured": False,
            "is_active": False,
            "title": "",
            "description": None,
            "countdown_target": None,
            "background_color": "#6C5CE7",
            "logo_url": None,
        }
    return {
        "configured": True,
        "is_active": bool(b.is_active),
        "title": b.title,
        "description": b.description,
        "countdown_target": b.countdown_target.isoformat() if b.countdown_target else None,
        "background_color": b.background_color,
        "logo_url": b.logo_url,
        "updated_at": b.updated_at.isoformat() if b.updated_at else None,
    }


# ── 요청 모델 ────────────────────────────────────────────────────────────


class ParticipantCreate(BaseModel):
    organizer_ref: str
    # 호출자가 생성하는 행 id — 재시도 멱등 앵커(같은 id 재전송 = 같은 행 갱신).
    item_id: uuid.UUID | None = None
    name: str = Field(..., min_length=1, max_length=200)
    role: str = "performer"
    bio: str | None = None
    image_url: str | None = Field(default=None, max_length=2000)
    sort_order: int = 0
    is_visible: bool = True


class ParticipantPatch(BaseModel):
    organizer_ref: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = None
    bio: str | None = None
    image_url: str | None = Field(default=None, max_length=2000)
    sort_order: int | None = None
    is_visible: bool | None = None


class NoticeCreate(BaseModel):
    organizer_ref: str
    item_id: uuid.UUID | None = None
    notice_type: str = "general"
    title: str = Field(..., min_length=1, max_length=300)
    content: str = Field(..., min_length=1)
    is_published: bool = False


class NoticePatch(BaseModel):
    organizer_ref: str
    notice_type: str | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    content: str | None = Field(default=None, min_length=1)
    is_published: bool | None = None


class FacilityCreate(BaseModel):
    organizer_ref: str
    item_id: uuid.UUID | None = None
    name: str = Field(..., min_length=1, max_length=200)
    category: str = "general"
    quantity: int = 1
    status: str = "planned"
    vendor: str | None = Field(default=None, max_length=200)
    cost: int = 0
    notes: str | None = None


class FacilityPatch(BaseModel):
    organizer_ref: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category: str | None = None
    quantity: int | None = None
    status: str | None = None
    vendor: str | None = Field(default=None, max_length=200)
    cost: int | None = None
    notes: str | None = None


class WidgetConfigPut(BaseModel):
    organizer_ref: str
    mode: str = "button"
    theme: dict = Field(default_factory=dict)
    allowed_domains: list[str] = Field(default_factory=list, max_length=200)
    is_active: bool = True


class TicketDesignPut(BaseModel):
    organizer_ref: str
    # top-level 병합 대상(전체교체 아님). 디자이너/초대권 편집기가 같은 문서를 공유한다.
    canvas_json: dict = Field(default_factory=dict)


class BridgePagePut(BaseModel):
    organizer_ref: str
    is_active: bool = False
    title: str = Field(default="", max_length=300)
    description: str | None = None
    countdown_target: str | None = None
    background_color: str = Field(default="#6C5CE7", max_length=20)
    logo_url: str | None = Field(default=None, max_length=2000)


# ══════════════════════════════════════════════════════════════════════════
# 출연진 (go event_participants)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/participants",
    summary="go read: 출연진 목록(주최자 — 숨김 포함)",
)
async def list_participants(
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
    rows = (
        await db.execute(
            select(OrganizerEventParticipant)
            .where(OrganizerEventParticipant.event_id == event_id)
            .order_by(OrganizerEventParticipant.sort_order)
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"participants": [_participant_out(p) for p in rows]})


@router.post(
    "/events/{event_id}/organizer-content/participants",
    status_code=201,
    summary="go write: 출연진 생성",
)
async def create_participant(
    event_id: uuid.UUID, body: ParticipantCreate, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.role, PARTICIPANT_ROLES, "role")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        item_id = body.item_id or uuid.uuid4()
        row = (
            await db.execute(
                select(OrganizerEventParticipant).where(OrganizerEventParticipant.id == item_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            # 재시도(같은 item_id) — 다른 이벤트의 행을 가로채는 것은 차단.
            if row.event_id != event_id:
                raise ApiError("ITEM_ID_CONFLICT", f"item_id already used: {item_id}", 409, "item_id")
        else:
            await _assert_capacity(db, OrganizerEventParticipant, event_id)
            row = OrganizerEventParticipant(id=item_id, event_id=event_id)
            db.add(row)
        row.name = body.name.strip()
        row.role = body.role
        row.bio = body.bio
        row.image_url = body.image_url
        row.sort_order = body.sort_order
        row.is_visible = body.is_visible
        row.updated_at = _now()
        await db.flush()
        await _reproject_participants(db, event_id)
        await _commit_or_conflict(db, "participant")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_participant_out(row))


@router.patch(
    "/events/{event_id}/organizer-content/participants/{item_id}",
    summary="go write: 출연진 수정",
)
async def patch_participant(
    event_id: uuid.UUID, item_id: uuid.UUID, body: ParticipantPatch, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.role, PARTICIPANT_ROLES, "role")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerEventParticipant).where(
                    OrganizerEventParticipant.id == item_id,
                    OrganizerEventParticipant.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("ITEM_NOT_FOUND", f"participant not found: {item_id}", 404)
        # 전달된 필드만 반영(model_fields_set) — COALESCE 방식과 달리 명시적 null 도 반영된다.
        fields = body.model_fields_set
        for key in ("name", "role", "bio", "image_url", "sort_order", "is_visible"):
            if key in fields:
                setattr(row, key, getattr(body, key))
        row.updated_at = _now()
        await db.flush()
        await _reproject_participants(db, event_id)
        await _commit_or_conflict(db, "participant")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_participant_out(row))


@router.delete(
    "/events/{event_id}/organizer-content/participants/{item_id}",
    summary="go write: 출연진 삭제",
)
async def delete_participant(
    event_id: uuid.UUID, item_id: uuid.UUID, organizer_ref: str, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerEventParticipant).where(
                    OrganizerEventParticipant.id == item_id,
                    OrganizerEventParticipant.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            # 🔴 "이미 없음 → 200 deleted" 금지. 없으면 없다고 말한다.
            raise ApiError("ITEM_NOT_FOUND", f"participant not found: {item_id}", 404)
        await db.delete(row)
        await db.flush()
        await _reproject_participants(db, event_id)
        await _commit_or_conflict(db, "participant")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok({"deleted": True, "id": str(item_id)})


# ══════════════════════════════════════════════════════════════════════════
# 공개 공지 (go open_notices)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/notices",
    summary="go read: 공지 목록(주최자 — 미발행 포함)",
)
async def list_notices(
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
    rows = (
        await db.execute(
            select(OrganizerOpenNotice)
            .where(OrganizerOpenNotice.event_id == event_id)
            .order_by(OrganizerOpenNotice.created_at.desc())
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"notices": [_notice_out(n) for n in rows]})


@router.post(
    "/events/{event_id}/organizer-content/notices",
    status_code=201,
    summary="go write: 공지 생성",
)
async def create_notice(
    event_id: uuid.UUID, body: NoticeCreate, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.notice_type, NOTICE_TYPES, "notice_type")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        item_id = body.item_id or uuid.uuid4()
        row = (
            await db.execute(
                select(OrganizerOpenNotice).where(OrganizerOpenNotice.id == item_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            if row.event_id != event_id:
                raise ApiError("ITEM_ID_CONFLICT", f"item_id already used: {item_id}", 409, "item_id")
        else:
            await _assert_capacity(db, OrganizerOpenNotice, event_id)
            row = OrganizerOpenNotice(id=item_id, event_id=event_id)
            db.add(row)
        row.notice_type = body.notice_type
        row.title = body.title
        row.content = body.content
        row.is_published = body.is_published
        row.published_at = _now() if body.is_published else None
        row.updated_at = _now()
        await db.flush()
        await _reproject_notices(db, event_id)
        await _commit_or_conflict(db, "notice")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_notice_out(row))


@router.patch(
    "/events/{event_id}/organizer-content/notices/{item_id}",
    summary="go write: 공지 수정(발행 전환 포함)",
)
async def patch_notice(
    event_id: uuid.UUID, item_id: uuid.UUID, body: NoticePatch, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.notice_type, NOTICE_TYPES, "notice_type")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerOpenNotice).where(
                    OrganizerOpenNotice.id == item_id,
                    OrganizerOpenNotice.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("ITEM_NOT_FOUND", f"notice not found: {item_id}", 404)
        fields = body.model_fields_set
        for key in ("notice_type", "title", "content", "is_published"):
            if key in fields:
                setattr(row, key, getattr(body, key))
        if "is_published" in fields and body.is_published and row.published_at is None:
            # 최초 발행 시각만 기록(go `COALESCE(published_at, NOW())` 와 동일 — 재발행이
            # 최초 발행 시각을 덮어쓰지 않는다).
            row.published_at = _now()
        row.updated_at = _now()
        await db.flush()
        await _reproject_notices(db, event_id)
        await _commit_or_conflict(db, "notice")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_notice_out(row))


@router.delete(
    "/events/{event_id}/organizer-content/notices/{item_id}",
    summary="go write: 공지 삭제",
)
async def delete_notice(
    event_id: uuid.UUID, item_id: uuid.UUID, organizer_ref: str, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerOpenNotice).where(
                    OrganizerOpenNotice.id == item_id,
                    OrganizerOpenNotice.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("ITEM_NOT_FOUND", f"notice not found: {item_id}", 404)
        await db.delete(row)
        await db.flush()
        await _reproject_notices(db, event_id)
        await _commit_or_conflict(db, "notice")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok({"deleted": True, "id": str(item_id)})


# ══════════════════════════════════════════════════════════════════════════
# 시설 (go event_facilities)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/facilities",
    summary="go read: 시설 목록(주최자 — vendor/cost/notes 포함)",
)
async def list_facilities(
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
    rows = (
        await db.execute(
            select(OrganizerEventFacility)
            .where(OrganizerEventFacility.event_id == event_id)
            .order_by(OrganizerEventFacility.category, OrganizerEventFacility.name)
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"facilities": [_facility_out(f) for f in rows]})


@router.post(
    "/events/{event_id}/organizer-content/facilities",
    status_code=201,
    summary="go write: 시설 생성",
)
async def create_facility(
    event_id: uuid.UUID, body: FacilityCreate, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.category, FACILITY_CATEGORIES, "category")
        _validate_enum(body.status, FACILITY_STATUSES, "status")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        item_id = body.item_id or uuid.uuid4()
        row = (
            await db.execute(
                select(OrganizerEventFacility).where(OrganizerEventFacility.id == item_id)
            )
        ).scalar_one_or_none()
        if row is not None:
            if row.event_id != event_id:
                raise ApiError("ITEM_ID_CONFLICT", f"item_id already used: {item_id}", 409, "item_id")
        else:
            await _assert_capacity(db, OrganizerEventFacility, event_id)
            row = OrganizerEventFacility(id=item_id, event_id=event_id)
            db.add(row)
        row.name = body.name.strip()
        row.category = body.category
        row.quantity = body.quantity
        row.status = body.status
        row.vendor = body.vendor
        row.cost = body.cost
        row.notes = body.notes
        row.updated_at = _now()
        await db.flush()
        await _reproject_facilities(db, event_id)
        await _commit_or_conflict(db, "facility")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_facility_out(row))


@router.patch(
    "/events/{event_id}/organizer-content/facilities/{item_id}",
    summary="go write: 시설 수정",
)
async def patch_facility(
    event_id: uuid.UUID, item_id: uuid.UUID, body: FacilityPatch, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.category, FACILITY_CATEGORIES, "category")
        _validate_enum(body.status, FACILITY_STATUSES, "status")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerEventFacility).where(
                    OrganizerEventFacility.id == item_id,
                    OrganizerEventFacility.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("ITEM_NOT_FOUND", f"facility not found: {item_id}", 404)
        fields = body.model_fields_set
        for key in ("name", "category", "quantity", "status", "vendor", "cost", "notes"):
            if key in fields:
                setattr(row, key, getattr(body, key))
        row.updated_at = _now()
        await db.flush()
        await _reproject_facilities(db, event_id)
        await _commit_or_conflict(db, "facility")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_facility_out(row))


@router.delete(
    "/events/{event_id}/organizer-content/facilities/{item_id}",
    summary="go write: 시설 삭제",
)
async def delete_facility(
    event_id: uuid.UUID, item_id: uuid.UUID, organizer_ref: str, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerEventFacility).where(
                    OrganizerEventFacility.id == item_id,
                    OrganizerEventFacility.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise ApiError("ITEM_NOT_FOUND", f"facility not found: {item_id}", 404)
        await db.delete(row)
        await db.flush()
        await _reproject_facilities(db, event_id)
        await _commit_or_conflict(db, "facility")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok({"deleted": True, "id": str(item_id)})


# ══════════════════════════════════════════════════════════════════════════
# 위젯 설정 (go widget_configs)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/widget-config",
    summary="go read: 위젯 설정(주최자)",
)
async def get_widget_config(
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
    row = (
        await db.execute(
            select(OrganizerWidgetConfig).where(OrganizerWidgetConfig.event_id == event_id)
        )
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_widget_out(row))


@router.put(
    "/events/{event_id}/organizer-content/widget-config",
    summary="go write: 위젯 설정 저장(1:1 upsert)",
)
async def put_widget_config(
    event_id: uuid.UUID, body: WidgetConfigPut, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        _validate_enum(body.mode, WIDGET_MODES, "mode")
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerWidgetConfig).where(OrganizerWidgetConfig.event_id == event_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = OrganizerWidgetConfig(event_id=event_id)
            db.add(row)
        row.mode = body.mode
        row.theme = body.theme
        # 화이트리스트는 **전체교체**(주최자가 도메인을 지우면 실제로 지워져야 한다).
        row.allowed_domains = [d.strip() for d in body.allowed_domains if d and d.strip()]
        row.is_active = body.is_active
        row.updated_at = _now()
        await _commit_or_conflict(db, "widget_config")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_widget_out(row))


@router.get(
    "/events/{event_id}/public-content/widget-config",
    summary="공개 위젯: embed 설정(허용 도메인 포함)",
)
async def get_public_widget_config(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """공개 위젯 라우트 전용 — organizer_ref 없이 이벤트 단위로 읽는다.

    🔴 호출측은 이 응답을 못 받았을 때 **절대 "제한 없음"으로 폴백하면 안 된다**(fail-closed).
    """
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    row = (
        await db.execute(
            select(OrganizerWidgetConfig).where(OrganizerWidgetConfig.event_id == event_id)
        )
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_widget_out(row))


# ══════════════════════════════════════════════════════════════════════════
# 티켓 디자인 (go ticket_designs)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/ticket-design",
    summary="go read: 티켓 디자인 canvas(주최자)",
)
async def get_ticket_design(
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
    row = (
        await db.execute(
            select(OrganizerTicketDesign).where(OrganizerTicketDesign.event_id == event_id)
        )
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"canvas_json": (row.canvas_json if row else {}) or {}})


@router.put(
    "/events/{event_id}/organizer-content/ticket-design",
    summary="go write: 티켓 디자인 저장(top-level 병합)",
)
async def put_ticket_design(
    event_id: uuid.UUID, body: TicketDesignPut, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        row = (
            await db.execute(
                select(OrganizerTicketDesign).where(OrganizerTicketDesign.event_id == event_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = OrganizerTicketDesign(event_id=event_id)
            db.add(row)
        # 병합(overwrite 금지) — 티켓 디자이너와 초대권 편집기가 같은 문서를 공유하므로
        # 넘어온 키만 갱신한다. go jsonb `||` 와 동일 시맨틱.
        merged = dict(row.canvas_json or {})
        merged.update(body.canvas_json or {})
        row.canvas_json = merged
        row.status = "published"
        row.updated_at = _now()
        await _commit_or_conflict(db, "ticket_design")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok({"canvas_json": row.canvas_json or {}})


@router.get(
    "/events/{event_id}/public-content/ticket-design",
    summary="공개 티켓뷰: 티켓 디자인 canvas",
)
async def get_public_ticket_design(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    row = (
        await db.execute(
            select(OrganizerTicketDesign).where(OrganizerTicketDesign.event_id == event_id)
        )
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"canvas_json": (row.canvas_json if row else None)})


# ══════════════════════════════════════════════════════════════════════════
# 브릿지 페이지 (go bridge_pages)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/organizer-content/bridge-page",
    summary="go read: 브릿지 페이지 설정",
)
async def get_bridge_page(
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
    row = (
        await db.execute(
            select(OrganizerBridgePage).where(OrganizerBridgePage.event_id == event_id)
        )
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_bridge_out(row))


@router.put(
    "/events/{event_id}/organizer-content/bridge-page",
    summary="go write: 브릿지 페이지 저장(1:1 upsert)",
)
async def put_bridge_page(
    event_id: uuid.UUID, body: BridgePagePut, request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _owned_event(db, event_id, body.organizer_ref, lock=True)
        countdown = None
        if body.countdown_target:
            try:
                countdown = _parse_iso(body.countdown_target)
            except (ValueError, TypeError) as exc:
                raise ApiError(
                    "VALIDATION_ERROR",
                    f"countdown_target is not a valid datetime: {body.countdown_target}",
                    400,
                    "countdown_target",
                ) from exc
        row = (
            await db.execute(
                select(OrganizerBridgePage).where(OrganizerBridgePage.event_id == event_id)
            )
        ).scalar_one_or_none()
        if row is None:
            row = OrganizerBridgePage(event_id=event_id)
            db.add(row)
        row.is_active = body.is_active
        row.title = body.title
        row.description = body.description
        row.countdown_target = countdown
        row.background_color = body.background_color
        row.logo_url = body.logo_url
        row.updated_at = _now()
        await _commit_or_conflict(db, "bridge_page")
    except ApiError as e:
        await db.rollback()
        return _err(e)
    return _ok(_bridge_out(row))


# ══════════════════════════════════════════════════════════════════════════
# 공개 공지 — 소비자/공개 랜딩용 read (발행분만)
# ══════════════════════════════════════════════════════════════════════════


@router.get(
    "/events/{event_id}/public-content/notices",
    summary="공개 랜딩: 발행된 공지만",
)
async def list_public_notices(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    limit: int = 10,
):
    """발행(is_published=true) 공지만. 미발행 초안은 절대 나가지 않는다."""
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rows = (
        await db.execute(
            select(OrganizerOpenNotice)
            .where(
                OrganizerOpenNotice.event_id == event_id,
                OrganizerOpenNotice.is_published.is_(True),
            )
            .order_by(
                OrganizerOpenNotice.published_at.desc().nullslast(),
                OrganizerOpenNotice.created_at.desc(),
            )
            .limit(max(1, min(limit, 100)))
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"notices": [_notice_out(n) for n in rows]})
