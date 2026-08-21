"""go 주최자 계정 화면 read/write — 레벨2 컷오버 T1.

go 는 `users INNER JOIN accounts` 로 계정·설정·알림 화면을 그렸다. 컷오버로 go `accounts`
가 비워지면서 `/api/account`, `/api/account/settings`, `/api/account/notifications` 가
**전부 404** 로 파손됐다(데이터 없음과 조회 실패가 화면에서 구분되지 않아 원인 추적도 막혔다).

정본을 v2 `organizer_profiles` 로 옮기고, go 는 이 엔드포인트만 호출한다.
  - 회사/사업자/연락처 : organizer_profiles 기존 컬럼
  - 알림 설정·로케일   : mig `mainfix_0727` 가산 컬럼(notification_prefs / timezone / currency)
  - 사용자 이름·연락처 : users (세션 주최자 본인)

⚠️ organizer_ref = go `accounts.id` 앵커(= session.accountId). `_resolve_organizer` 가
   테넌트 경계를 강제하며 불일치는 404 다.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _err,
    _internal_auth,
    _ok,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.organizer import OrganizerProfile
from app.models.user import User

router = APIRouter(dependencies=[Depends(_internal_auth)])

# go accounts.notification_prefs 와 동일한 6키. 알 수 없는 키는 무시한다.
_PREF_KEYS = ("orders", "sold_out", "refunds", "payment_failed", "check_in", "ai")
_PREF_DEFAULTS = {k: True for k in _PREF_KEYS}


def _parse_ref(ref: str) -> OrganizerRef:
    """go accounts.id(문자열) 또는 v2 user uuid 를 OrganizerRef 로 정규화."""
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except (ValueError, AttributeError, TypeError):
        return OrganizerRef(go_account_id=ref)


def _normalize_prefs(raw: object) -> dict[str, bool]:
    """저장된 JSONB 를 기본값과 병합해 완전한 6키로 정규화(go 기존 계약과 동일)."""
    merged = dict(_PREF_DEFAULTS)
    if isinstance(raw, dict):
        for k in _PREF_KEYS:
            v = raw.get(k)
            if isinstance(v, bool):
                merged[k] = v
    return merged


async def _load(db: AsyncSession, organizer_ref: str) -> tuple[OrganizerProfile, User]:
    organizer_id = await _resolve_organizer(db, _parse_ref(organizer_ref))
    profile = (
        await db.execute(
            select(OrganizerProfile).where(
                OrganizerProfile.user_id == organizer_id,
                OrganizerProfile.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    if profile is None:
        raise ApiError("NOT_FOUND", "organizer profile not found", 404)
    user = (await db.execute(select(User).where(User.id == organizer_id))).scalars().first()
    if user is None:
        raise ApiError("NOT_FOUND", "organizer user not found", 404)
    return profile, user


def _payload(profile: OrganizerProfile, user: User) -> dict:
    return {
        "id": str(profile.id),
        # 사용자(주최자 본인)
        "name": user.name or "",
        "email": user.email or "",
        "phone": user.phone,
        # 조직/사업자
        "company_name": profile.company_name,
        "business_number": profile.business_number,
        "representative_name": profile.representative_name,
        "contact_email": profile.contact_email,
        "contact_phone": profile.contact_phone,
        "slug": profile.slug,
        "status": profile.status.value if hasattr(profile.status, "value") else str(profile.status),
        "timezone": profile.timezone,
        "currency": profile.currency,
        "is_active": profile.deleted_at is None,
        "notification_prefs": _normalize_prefs(profile.notification_prefs),
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


class OrganizerAccountPatch(BaseModel):
    """부분 수정 — 전달된 필드만 반영한다(미전달 = 변경 없음)."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=50)
    company_name: str | None = Field(default=None, min_length=1, max_length=200)
    business_number: str | None = Field(default=None, max_length=100)
    representative_name: str | None = Field(default=None, max_length=200)
    contact_email: str | None = Field(default=None, max_length=320)
    contact_phone: str | None = Field(default=None, max_length=50)
    timezone: str | None = Field(default=None, max_length=64)
    currency: str | None = Field(default=None, max_length=8)
    notification_prefs: dict[str, bool] | None = None


@router.get("/organizers/{organizer_ref}/account", summary="go read: 주최자 계정/설정/알림")
async def get_organizer_account(
    organizer_ref: str, response: Response, db: AsyncSession = Depends(get_db)
):
    try:
        profile, user = await _load(db, organizer_ref)
    except ApiError as e:
        return _err(e)
    return _ok(_payload(profile, user))


@router.patch("/organizers/{organizer_ref}/account", summary="go write: 주최자 계정/설정/알림 수정")
async def patch_organizer_account(
    organizer_ref: str, body: OrganizerAccountPatch, db: AsyncSession = Depends(get_db)
):
    try:
        profile, user = await _load(db, organizer_ref)
    except ApiError as e:
        return _err(e)

    if body.name is not None:
        user.name = body.name
    if body.phone is not None:
        user.phone = body.phone or None
    if body.company_name is not None:
        profile.company_name = body.company_name
    if body.business_number is not None:
        profile.business_number = body.business_number or None
    if body.representative_name is not None:
        profile.representative_name = body.representative_name or None
    if body.contact_email is not None:
        profile.contact_email = body.contact_email
    if body.contact_phone is not None:
        profile.contact_phone = body.contact_phone or None
    if body.timezone is not None:
        profile.timezone = body.timezone
    if body.currency is not None:
        profile.currency = body.currency
    if body.notification_prefs is not None:
        # 기존 값 위에 병합 — 알 수 없는 키는 버린다.
        profile.notification_prefs = _normalize_prefs(
            {**_normalize_prefs(profile.notification_prefs), **body.notification_prefs}
        )

    await db.commit()
    await db.refresh(profile)
    await db.refresh(user)
    return _ok(_payload(profile, user))
