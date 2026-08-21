"""레벨2 W2-EVT — 주최자 표기 엔티티(go organizers / event_organizers) 내부 API.

go DB 를 완전히 제거하기 위해 go 에만 있던 두 테이블을 v2 정본으로 흡수했다.
  go organizers        → v2 `event_hosts`      (계정당 N개인 순수 표기용 엔티티)
  go event_organizers  → v2 `event_host_links` (이벤트↔주최자 M:N, 역할·표시순서)

⚠️ v2 `organizer_profiles`(user 1:1 사업자 프로필) / `organizer_team_members`(v2 계정 협업자)
와는 **개념이 다르다** — go organizers 는 v2 user 계정이 없는 표기용 엔티티라 재사용 불가.

테넌트 경계(Critical): go 의 `account_id` 는 v2 `organizer_id`(users.id, events.organizer_id 와
동일 축)로 이관됐다. **이 파일의 모든 조회·변경 쿼리에는 organizer_id 조건이 들어간다.**
소유자 불일치는 존재 노출을 피해 404 로 투영하고, v2 내부 오류를 404/빈 목록으로 위장하지
않는다(fail-closed).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import case, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _err,
    _internal_auth,
    _ok,
    _READ_CACHE_CONTROL,
    _require_event,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.event import Event
from app.models.event_host import EVENT_HOST_ROLE_ORDER, EVENT_HOST_ROLES, EventHost, EventHostLink

router = APIRouter(dependencies=[Depends(_internal_auth)])

# batch 조회 상한 — 무제한 IN 절로 DB 를 태우는 경로 차단.
_MAX_BATCH_EVENT_IDS = 200

# 표시 정렬: host → coordinator → sponsor → (알 수 없는 역할은 뒤로)
_ROLE_RANK = case(
    *[(EventHostLink.role == role, rank) for role, rank in EVENT_HOST_ROLE_ORDER.items()],
    else_=99,
)


# ── 공통 유틸 ────────────────────────────────────────────────────────────


def _parse_org_ref(ref: str) -> OrganizerRef:
    """organizer_ref 문자열 파싱 — internal_commerce_read._parse_org_ref 와 동일 규약.

    UUID 로 읽히면 v2 organizer_id(불발 시 go account_id 로 재해석은 _resolve_organizer 담당),
    아니면 go accounts.id 문자열로 본다. 원본 수정 금지 규약 때문에 로직을 복제한다.
    """
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except ValueError:
        return OrganizerRef(go_account_id=ref)


def _to_ref(raw: str | OrganizerRef) -> OrganizerRef:
    """body/query 어느 쪽 표기(문자열 ref 또는 {go_account_id|organizer_id})든 받는다."""
    if isinstance(raw, OrganizerRef):
        return raw
    return _parse_org_ref(str(raw))


async def _owned_host(db: AsyncSession, host_id: uuid.UUID, organizer_id: uuid.UUID) -> EventHost:
    """host 단건 + 테넌트 경계. 미존재·타 organizer 소유는 구분 없이 404(존재 노출 금지)."""
    host = (
        await db.execute(
            select(EventHost).where(
                EventHost.id == host_id, EventHost.organizer_id == organizer_id
            )
        )
    ).scalar_one_or_none()
    if host is None:
        raise ApiError("HOST_NOT_FOUND", f"event host not found: {host_id}", 404)
    return host


async def _owned_event(
    db: AsyncSession, event_id: uuid.UUID, organizer_id: uuid.UUID, *, lock: bool = False
) -> Event:
    """이벤트 소유 검증. 불일치는 go 기존 계약과 동일하게 404 로 투영한다.

    lock=True 면 events 행을 FOR UPDATE 로 잡아 같은 이벤트에 대한 동시 PUT 을 직렬화한다
    (SQLite 는 FOR UPDATE 를 렌더하지 않으므로 테스트 경로에 무해).
    """
    if lock:
        stmt = select(Event).where(Event.id == event_id).with_for_update()
        event = (await db.execute(stmt)).scalar_one_or_none()
        if event is None:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    else:
        event = await _require_event(db, event_id)
    if event.organizer_id != organizer_id:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    return event


def _host_out(h: EventHost) -> dict:
    return {
        "host_id": str(h.id),
        "name": h.name,
        "slug": h.slug,
        "description": h.description,
        "email": h.email,
        "phone": h.phone,
        "logo_url": h.logo_url,
        "contact_public": bool(h.contact_public),
        "is_published": bool(h.is_published),
        "created_at": h.created_at.isoformat() if h.created_at else None,
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
    }


def _link_out(link: EventHostLink, h: EventHost) -> dict:
    """연결 + 표기 스냅샷.

    email/phone 은 그대로 싣는다 — 이 API 는 소유 organizer 전용(내부 서비스 토큰/HMAC)이라
    주최자 본인 데이터다. **공개 노출 여부의 게이트는 `contact_public`** 이며, 소비자 화면에
    내보낼지는 호출측(go/consumer)이 이 플래그로 판단한다.
    """
    return {
        "link_id": str(link.id),
        "host_id": str(h.id),
        "role": link.role,
        "display_order": int(link.display_order or 0),
        "name": h.name,
        "slug": h.slug,
        "logo_url": h.logo_url,
        "contact_public": bool(h.contact_public),
        "email": h.email,
        "phone": h.phone,
    }


async def _event_links(db: AsyncSession, event_ids: list[uuid.UUID], organizer_id: uuid.UUID):
    """이벤트 목록의 링크를 **단일 조인 쿼리**로 조회(N+1 금지). 정렬까지 DB 가 확정한다."""
    if not event_ids:
        return []
    return (
        await db.execute(
            select(EventHostLink, EventHost)
            .join(EventHost, EventHost.id == EventHostLink.host_id)
            .join(Event, Event.id == EventHostLink.event_id)
            .where(
                EventHostLink.event_id.in_(event_ids),
                # 이중 경계 — 이벤트도, host 도 이 organizer 것이어야 한다.
                Event.organizer_id == organizer_id,
                EventHost.organizer_id == organizer_id,
            )
            .order_by(
                EventHostLink.event_id,
                _ROLE_RANK,
                EventHostLink.display_order,
                EventHostLink.created_at,
            )
        )
    ).all()


# ── 요청 모델 ────────────────────────────────────────────────────────────


class HostCreateRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    name: str = Field(..., min_length=1, max_length=200)
    slug: str = Field(..., min_length=1, max_length=120)
    description: str | None = None
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=50)
    logo_url: str | None = Field(default=None, max_length=500)
    contact_public: bool = False
    is_published: bool = False
    # go organizers.id 보존 백필 훅 — 주면 그 UUID 를 PK 로 쓴다(딥링크·기존 참조 유지).
    host_id: uuid.UUID | None = None


class HostPatchRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=50)
    logo_url: str | None = Field(default=None, max_length=500)
    contact_public: bool | None = None
    is_published: bool | None = None


class HostLinkIn(BaseModel):
    host_id: uuid.UUID
    role: str = "host"
    display_order: int = 0


class EventHostsPutRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    hosts: list[HostLinkIn] = Field(default_factory=list)


class HostBatchRequest(BaseModel):
    organizer_ref: str | OrganizerRef
    event_ids: list[uuid.UUID] = Field(default_factory=list)


# ── 1. 목록 ──────────────────────────────────────────────────────────────


@router.get("/event-hosts", summary="go read: 주최자 표기 엔티티 목록")
async def list_event_hosts(
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    rows = (
        await db.execute(
            select(EventHost)
            .where(EventHost.organizer_id == organizer_id)  # 테넌트 경계(필수)
            .order_by(EventHost.created_at.desc())
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"hosts": [_host_out(h) for h in rows]})


# ── 2. 생성(+ go id 보존 멱등 upsert) ────────────────────────────────────


@router.post("/event-hosts", status_code=201, summary="go write: 주최자 표기 엔티티 생성")
async def create_event_host(
    body: HostCreateRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """생성. `host_id` 를 주면 go organizers.id 를 보존한 **멱등 upsert** 로 동작한다.

    동시 2회 실행: 같은 host_id 면 두 번째는 같은 행을 갱신(값 동일 → 무해), 다른 요청이
    같은 (organizer_id, slug) 를 노리면 UNIQUE 가 한쪽을 IntegrityError 로 떨어뜨려
    409 로 변환한다(부분 생성 없음 — 단일 트랜잭션 커밋).
    """
    try:
        organizer_id = await _resolve_organizer(db, _to_ref(body.organizer_ref))
    except ApiError as e:
        return _err(e)

    name = body.name.strip()
    slug = body.slug.strip()
    if not name or not slug:
        return _err(ApiError("VALIDATION_ERROR", "name/slug 는 비어 있을 수 없습니다", 400, "slug"))

    now = datetime.now(timezone.utc)

    if body.host_id is not None:
        existing = (
            await db.execute(select(EventHost).where(EventHost.id == body.host_id))
        ).scalar_one_or_none()
        if existing is not None:
            if existing.organizer_id != organizer_id:
                # 🔴 남의 host_id 를 자기 계정으로 덮어쓰는 경로 차단.
                return _err(
                    ApiError(
                        "HOST_ID_CONFLICT",
                        f"host_id already owned by another organizer: {body.host_id}",
                        409,
                        "host_id",
                    )
                )
            if slug != existing.slug:
                dup = (
                    await db.execute(
                        select(EventHost.id).where(
                            EventHost.organizer_id == organizer_id,
                            EventHost.slug == slug,
                            EventHost.id != existing.id,
                        )
                    )
                ).scalar_one_or_none()
                if dup is not None:
                    return _err(
                        ApiError("HOST_SLUG_CONFLICT", f"slug already in use: {slug}", 409, "slug")
                    )
            # 멱등 upsert — go 원본 행이 정본이므로 전달값으로 전체 갱신한다.
            existing.name = name
            existing.slug = slug
            existing.description = body.description
            existing.email = body.email
            existing.phone = body.phone
            existing.logo_url = body.logo_url
            existing.contact_public = body.contact_public
            existing.is_published = body.is_published
            existing.updated_at = now
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
                return _err(
                    ApiError("HOST_SLUG_CONFLICT", f"slug already in use: {slug}", 409, "slug")
                )
            await db.refresh(existing)
            return _ok(_host_out(existing))

    dup = (
        await db.execute(
            select(EventHost.id).where(
                EventHost.organizer_id == organizer_id, EventHost.slug == slug
            )
        )
    ).scalar_one_or_none()
    if dup is not None:
        return _err(ApiError("HOST_SLUG_CONFLICT", f"slug already in use: {slug}", 409, "slug"))

    host = EventHost(
        id=body.host_id or uuid.uuid4(),
        organizer_id=organizer_id,
        name=name,
        slug=slug,
        description=body.description,
        email=body.email,
        phone=body.phone,
        logo_url=body.logo_url,
        contact_public=body.contact_public,
        is_published=body.is_published,
        created_at=now,
        updated_at=now,
    )
    db.add(host)
    try:
        await db.commit()
    except IntegrityError:
        # 동시 생성 레이스 — UNIQUE(organizer_id, slug) 가 한쪽만 통과시킨다.
        await db.rollback()
        return _err(ApiError("HOST_SLUG_CONFLICT", f"slug already in use: {slug}", 409, "slug"))
    await db.refresh(host)
    return _ok(_host_out(host))


# ── 3. 단건 조회 ─────────────────────────────────────────────────────────


@router.get("/event-hosts/{host_id}", summary="go read: 주최자 표기 엔티티 단건")
async def get_event_host(
    host_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
        host = await _owned_host(db, host_id, organizer_id)
    except ApiError as e:
        return _err(e)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_host_out(host))


# ── 4. 수정 ──────────────────────────────────────────────────────────────


@router.patch("/event-hosts/{host_id}", summary="go write: 주최자 표기 엔티티 수정")
async def patch_event_host(
    host_id: uuid.UUID,
    body: HostPatchRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """부분 PATCH — 미전송 키는 보존. `slug` 는 변경 불가(딥링크/백필 앵커라 무시한다)."""
    try:
        organizer_id = await _resolve_organizer(db, _to_ref(body.organizer_ref))
        host = await _owned_host(db, host_id, organizer_id)
    except ApiError as e:
        return _err(e)

    sent = body.model_fields_set
    if "name" in sent and body.name is not None:
        name = body.name.strip()
        if not name:
            return _err(ApiError("VALIDATION_ERROR", "name 은 비어 있을 수 없습니다", 400, "name"))
        host.name = name
    for field in ("description", "email", "phone", "logo_url"):
        if field in sent:
            setattr(host, field, getattr(body, field))
    for field in ("contact_public", "is_published"):
        if field in sent and getattr(body, field) is not None:
            setattr(host, field, bool(getattr(body, field)))
    host.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(host)
    return _ok(_host_out(host))


# ── 5. 삭제 ──────────────────────────────────────────────────────────────


@router.delete("/event-hosts/{host_id}", summary="go write: 주최자 표기 엔티티 삭제")
async def delete_event_host(
    host_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    unlink: bool = False,
):
    """삭제. 연결된 이벤트가 있으면 `unlink=true` 없이는 지우지 않는다(사고 방지 2단 확인).

    unlink=true 경로는 링크 삭제 + host 삭제를 **하나의 트랜잭션**으로 커밋한다 —
    중간에 죽어도 "링크만 사라지고 host 는 남는" 반쪽 상태가 생기지 않는다.
    """
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
        host = await _owned_host(db, host_id, organizer_id)
    except ApiError as e:
        return _err(e)

    linked = int(
        (
            await db.execute(
                select(func.count(EventHostLink.id)).where(EventHostLink.host_id == host.id)
            )
        ).scalar()
        or 0
    )
    if linked > 0 and not unlink:
        return _ok(
            {
                "deleted": False,
                "needs_unlink": True,
                "linked_event_count": linked,
                "unlinked_event_count": 0,
            }
        )

    await db.execute(delete(EventHostLink).where(EventHostLink.host_id == host.id))
    await db.delete(host)
    await db.commit()
    return _ok(
        {
            "deleted": True,
            "needs_unlink": False,
            "linked_event_count": linked,
            "unlinked_event_count": linked,
        }
    )


# ── 6. 이벤트 연결 조회 ──────────────────────────────────────────────────


@router.get("/events/{event_id}/hosts", summary="go read: 이벤트 주최자 목록")
async def list_event_hosts_of_event(
    event_id: uuid.UUID,
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
        await _owned_event(db, event_id, organizer_id)
    except ApiError as e:
        return _err(e)
    rows = await _event_links(db, [event_id], organizer_id)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"hosts": [_link_out(link, host) for link, host in rows]})


# ── 7. 이벤트 연결 전량 교체 ─────────────────────────────────────────────


@router.put("/events/{event_id}/hosts", summary="go write: 이벤트 주최자 연결 교체")
async def put_event_hosts(
    event_id: uuid.UUID,
    body: EventHostsPutRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """전량 교체(replace). 검증을 **전부 통과한 뒤에만** 삭제+삽입한다(부분 반영 금지).

    동시 2회 실행: events 행을 FOR UPDATE 로 잡아 같은 이벤트의 교체를 직렬화하고,
    그래도 겹치면 UNIQUE(event_id, host_id, role) 가 한쪽을 IntegrityError → 409 로 만든다.
    삭제·삽입은 같은 트랜잭션이라 crash 시 이전 연결이 그대로 남는다(링크 유실 없음).
    """
    try:
        organizer_id = await _resolve_organizer(db, _to_ref(body.organizer_ref))
        await _owned_event(db, event_id, organizer_id, lock=True)
    except ApiError as e:
        return _err(e)

    if not body.hosts:
        return _err(
            ApiError("HOSTS_REQUIRED", "hosts 는 최소 1개 이상이어야 합니다", 400, "hosts")
        )

    bad_role = next((h.role for h in body.hosts if h.role not in EVENT_HOST_ROLES), None)
    if bad_role is not None:
        return _err(
            ApiError("INVALID_HOST_ROLE", f"invalid role: {bad_role}", 400, "hosts.role")
        )
    if not any(h.role == "host" for h in body.hosts):
        return _err(
            ApiError(
                "HOST_ROLE_REQUIRED", "role='host' 인 주최자가 최소 1개 필요합니다", 400, "hosts"
            )
        )

    pairs = [(h.host_id, h.role) for h in body.hosts]
    if len(set(pairs)) != len(pairs):
        # 조용히 dedup 하면 display_order 중 무엇이 반영됐는지 호출측이 알 수 없다 → 명시 거부.
        return _err(
            ApiError(
                "DUPLICATE_HOST_ROLE",
                "같은 (host_id, role) 조합이 중복됐습니다",
                400,
                "hosts",
            )
        )

    host_ids = list({h.host_id for h in body.hosts})
    owned = set(
        (
            await db.execute(
                select(EventHost.id).where(
                    EventHost.id.in_(host_ids), EventHost.organizer_id == organizer_id
                )
            )
        ).scalars().all()
    )
    if len(owned) != len(host_ids):
        # 🔴 하나라도 남의 host 면 전체 거부 — 부분 반영 금지.
        missing = [str(i) for i in host_ids if i not in owned]
        return _err(
            ApiError(
                "HOST_NOT_OWNED",
                f"host not owned by organizer: {', '.join(missing)}",
                400,
                "hosts",
            )
        )

    now = datetime.now(timezone.utc)
    await db.execute(delete(EventHostLink).where(EventHostLink.event_id == event_id))
    db.add_all(
        [
            EventHostLink(
                id=uuid.uuid4(),
                event_id=event_id,
                host_id=h.host_id,
                role=h.role,
                display_order=int(h.display_order or 0),
                created_at=now,
            )
            for h in body.hosts
        ]
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return _err(
            ApiError(
                "HOST_LINK_CONFLICT",
                "동시 변경으로 연결 교체가 충돌했습니다. 다시 시도하세요",
                409,
                "hosts",
            )
        )

    rows = await _event_links(db, [event_id], organizer_id)
    return _ok({"hosts": [_link_out(link, host) for link, host in rows]})


# ── 8. 배치 조회 ─────────────────────────────────────────────────────────


@router.post("/event-hosts/batch", summary="go read: 이벤트 다건 주최자 배치 조회")
async def batch_event_hosts(
    body: HostBatchRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """목록 화면용 배치 조회 — 단일 조인 쿼리(N+1 금지).

    소유하지 않은 event_id 는 결과 키에서 **빠진다**(존재 여부조차 노출하지 않는다).
    """
    try:
        organizer_id = await _resolve_organizer(db, _to_ref(body.organizer_ref))
    except ApiError as e:
        return _err(e)

    event_ids = list(dict.fromkeys(body.event_ids))
    if len(event_ids) > _MAX_BATCH_EVENT_IDS:
        return _err(
            ApiError(
                "TOO_MANY_EVENT_IDS",
                f"event_ids 는 최대 {_MAX_BATCH_EVENT_IDS}개까지 허용됩니다",
                400,
                "event_ids",
            )
        )
    if not event_ids:
        return _ok({"hosts_by_event": {}})

    rows = await _event_links(db, event_ids, organizer_id)
    grouped: dict[str, list[dict]] = {}
    for link, host in rows:
        grouped.setdefault(str(link.event_id), []).append(_link_out(link, host))
    return _ok({"hosts_by_event": grouped})
