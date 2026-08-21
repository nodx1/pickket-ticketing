"""사업자 인증 심사 API (레벨2 2차 D4 — go 흡수).

두 계층:
  1. 내부(go 프록시) — X-Pickket-Service-Token(전환기 HMAC 병행). go organizer 대시보드가
     계정 소유자/관리자 컨텍스트에서 사업자 정보·서류를 제출/조회한다. 테넌트 경계=go_account_id.
  2. admin(플랫폼 심사) — v2 admin 권한(get_current_admin) 게이트. 심사 대기열 조회 + 승인/반려.

상태머신:
    draft ──submit──▶ pending ──approve──▶ approved
                          └──reject──▶ rejected ──(save)──▶ draft
    approved/pending 은 편집 잠금(save/submit 409). rejected/unverified/draft 만 편집.

승인 원장(business_verifications.status='approved')이 v2 유료 발행 게이트의 정본.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.v1.internal_commerce import _internal_auth
from app.core.database import get_db
from app.middleware.auth import get_current_admin
from app.models.business_verification import (
    BizDocType,
    BizVerificationStatus,
    BusinessVerification,
    BusinessVerificationDocument,
)
from app.models.organizer import OrganizerProfile
from app.models.user import User

logger = logging.getLogger(__name__)

# 내부(go 프록시) 라우터 — 서명/토큰 인증(_internal_auth).
internal_router = APIRouter(dependencies=[Depends(_internal_auth)])
# admin(플랫폼 심사) 라우터 — v2 admin 권한.
admin_router = APIRouter()

_EDITABLE_STATUSES = {BizVerificationStatus.DRAFT, BizVerificationStatus.REJECTED}
_LOCKED_STATUSES = {BizVerificationStatus.PENDING, BizVerificationStatus.APPROVED}


# ── Schemas ──────────────────────────────────────────────────────────────────


class DocIn(BaseModel):
    doc_type: str = Field(..., pattern="^(biz_cert|bankbook|permit)$")
    file_url: str = Field(..., min_length=1, max_length=1000)
    storage_key: str | None = Field(None, max_length=500)


class SubmitIn(BaseModel):
    """go 계정 컨텍스트에서의 저장/제출. account_id = go accounts.id."""

    account_id: uuid.UUID
    action: str = Field(..., pattern="^(save|submit)$")
    biz_number: str | None = None
    company_name: str | None = None
    rep_name: str | None = None
    biz_type: str | None = None
    biz_item: str | None = None
    address: str | None = None
    opened_on: str | None = None  # YYYY-MM-DD
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    authorized_confirmed: bool | None = None
    masking_confirmed: bool | None = None
    documents: list[DocIn] = Field(default_factory=list, max_length=10)


class ReviewIn(BaseModel):
    action: str = Field(..., pattern="^(approve|reject)$")
    reason: str | None = None


# ── Serializers ──────────────────────────────────────────────────────────────


def _status_value(s: BizVerificationStatus | str) -> str:
    return s.value if isinstance(s, BizVerificationStatus) else str(s)


def _serialize_doc(d: BusinessVerificationDocument) -> dict:
    return {
        "doc_type": _status_value(d.doc_type) if isinstance(d.doc_type, BizDocType) else str(d.doc_type),
        "file_url": d.file_url,
        "storage_key": d.storage_key,
    }


def _serialize(v: BusinessVerification, *, include_docs: bool = True) -> dict:
    out = {
        "id": str(v.id),
        "account_id": str(v.go_account_id),
        "organizer_profile_id": str(v.organizer_profile_id) if v.organizer_profile_id else None,
        "biz_number": v.biz_number,
        "company_name": v.company_name,
        "rep_name": v.rep_name,
        "biz_type": v.biz_type,
        "biz_item": v.biz_item,
        "address": v.address,
        "opened_on": v.opened_on.isoformat() if v.opened_on else None,
        "bank_name": v.bank_name,
        "bank_account": v.bank_account,
        "bank_holder": v.bank_holder,
        "authorized_confirmed": v.authorized_confirmed,
        "masking_confirmed": v.masking_confirmed,
        "status": _status_value(v.status),
        "reviewed_by": str(v.reviewed_by) if v.reviewed_by else None,
        "reviewed_at": v.reviewed_at.isoformat() if v.reviewed_at else None,
        "rejected_reason": v.rejected_reason,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }
    if include_docs:
        out["documents"] = [_serialize_doc(d) for d in (v.documents or [])]
    return out


async def _resolve_profile_id(db: AsyncSession, account_id: uuid.UUID) -> uuid.UUID | None:
    """go_account_id → v2 OrganizerProfile.id (있으면). 승인 게이트 링크용."""
    row = await db.execute(
        select(OrganizerProfile.id).where(OrganizerProfile.go_account_id == str(account_id))
    )
    return row.scalar_one_or_none()


def _parse_opened_on(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()  # type: ignore[return-value]
    except ValueError:
        raise HTTPException(status_code=400, detail="opened_on 은 YYYY-MM-DD 형식이어야 합니다")


# ── 내부(go 프록시) 엔드포인트 ────────────────────────────────────────────────


@internal_router.get("/business-verifications/current")
async def get_current_verification(
    request: Request,
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """계정의 최신 인증 신청 + 승인 게이트 상태. go GET 프록시.

    반환: verification_status(게이트 정본, 최신 approved 있으면 approved), current(최신 행).
    """
    result = await db.execute(
        select(BusinessVerification)
        .options(selectinload(BusinessVerification.documents))
        .where(BusinessVerification.go_account_id == account_id)
        .order_by(BusinessVerification.created_at.desc())
        .limit(1)
    )
    current = result.scalar_one_or_none()

    # 게이트 상태 — approved 이력이 하나라도 있으면 approved(최신이 반려/재작성 중이어도
    # 승인 취소 전까지 발행 유지). 최신 행 status 를 우선 노출하되, approved 존재 여부도 별도 계산.
    approved_exists = await db.execute(
        select(func.count())
        .select_from(BusinessVerification)
        .where(
            BusinessVerification.go_account_id == account_id,
            BusinessVerification.status == BizVerificationStatus.APPROVED,
        )
    )
    has_approved = (approved_exists.scalar_one() or 0) > 0

    if current is None:
        verification_status = "unverified"
    else:
        verification_status = _status_value(current.status)

    return {
        "verification_status": verification_status,
        "has_approved": has_approved,
        "verified_at": current.reviewed_at.isoformat()
        if current and current.status == BizVerificationStatus.APPROVED and current.reviewed_at
        else None,
        "rejected_reason": current.rejected_reason
        if current and current.status == BizVerificationStatus.REJECTED
        else None,
        "current": _serialize(current) if current else None,
    }


@internal_router.put("/business-verifications")
async def upsert_verification(
    request: Request,
    body: SubmitIn,
    db: AsyncSession = Depends(get_db),
):
    """계정 컨텍스트 저장(save)/제출(submit). go PUT 프록시.

    멱등/경계:
      - 테넌트 경계 = go_account_id(요청 바디). 다른 계정 행 접근 불가.
      - 편집 가능 draft 행 재사용, 없으면 신규(재제출=새 행 아님, draft 재사용 → 중복 신청 방지).
      - approved/pending 상태면 409(편집 잠금). 최신 행 기준 판정.
      - 트랜잭션 단일 커밋 — 부분 반영 없음.
    """
    if body.action == "submit":
        missing = (
            not (body.biz_number or "").strip()
            or not (body.company_name or "").strip()
            or not (body.rep_name or "").strip()
            or not (body.bank_name or "").strip()
            or not (body.bank_account or "").strip()
            or not (body.bank_holder or "").strip()
            or not body.authorized_confirmed
            or not body.masking_confirmed
        )
        if missing:
            raise HTTPException(
                status_code=400,
                detail="필수 항목(사업자 정보·정산 계좌·확인 체크)을 모두 입력해주세요",
            )
        doc_types = {d.doc_type for d in body.documents}
        if "biz_cert" not in doc_types or "bankbook" not in doc_types:
            raise HTTPException(
                status_code=400, detail="사업자등록증과 통장 사본을 모두 첨부해주세요"
            )

    opened_on = _parse_opened_on(body.opened_on)

    # 최신 행 상태로 편집 잠금 판정.
    latest = (
        await db.execute(
            select(BusinessVerification)
            .where(BusinessVerification.go_account_id == body.account_id)
            .order_by(BusinessVerification.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is not None and latest.status in _LOCKED_STATUSES:
        raise HTTPException(
            status_code=409, detail="현재 상태에서는 인증 정보를 수정할 수 없습니다"
        )

    profile_id = await _resolve_profile_id(db, body.account_id)

    # 편집 가능 draft 행 재사용 or 신규.
    ver = (
        await db.execute(
            select(BusinessVerification)
            .options(selectinload(BusinessVerification.documents))
            .where(
                BusinessVerification.go_account_id == body.account_id,
                BusinessVerification.status == BizVerificationStatus.DRAFT,
            )
            .order_by(BusinessVerification.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if ver is None:
        ver = BusinessVerification(go_account_id=body.account_id, status=BizVerificationStatus.DRAFT)
        db.add(ver)

    ver.organizer_profile_id = profile_id
    ver.biz_number = body.biz_number
    ver.company_name = body.company_name
    ver.rep_name = body.rep_name
    ver.biz_type = body.biz_type
    ver.biz_item = body.biz_item
    ver.address = body.address
    ver.opened_on = opened_on
    ver.bank_name = body.bank_name
    ver.bank_account = body.bank_account
    ver.bank_holder = body.bank_holder
    ver.authorized_confirmed = bool(body.authorized_confirmed)
    ver.masking_confirmed = bool(body.masking_confirmed)
    ver.updated_at = datetime.now(timezone.utc)

    await db.flush()  # ver.id 확보

    # 서류 동기화(제공 목록으로 교체) — 명시 DELETE(관계 lazy-load 회피, async-safe).
    await db.execute(
        sa_delete(BusinessVerificationDocument).where(
            BusinessVerificationDocument.verification_id == ver.id
        )
    )
    await db.flush()
    for doc in body.documents:
        db.add(
            BusinessVerificationDocument(
                verification_id=ver.id,
                doc_type=BizDocType(doc.doc_type),
                file_url=doc.file_url,
                storage_key=doc.storage_key,
            )
        )

    if body.action == "submit":
        ver.status = BizVerificationStatus.PENDING

    await db.commit()
    return {"status": _status_value(ver.status), "id": str(ver.id)}


# ── 심사 로직(공통) ────────────────────────────────────────────────────────────


async def _do_list(db: AsyncSession, status_filter: str) -> dict:
    if status_filter not in {s.value for s in BizVerificationStatus}:
        raise HTTPException(status_code=400, detail="invalid status filter")
    rows = await db.execute(
        select(BusinessVerification)
        .where(BusinessVerification.status == BizVerificationStatus(status_filter))
        .order_by(BusinessVerification.created_at.asc())
        .limit(200)
    )
    items = rows.scalars().all()
    return {
        "data": [
            {
                "id": str(v.id),
                "account_id": str(v.go_account_id),
                "biz_number": v.biz_number,
                "company_name": v.company_name,
                "rep_name": v.rep_name,
                "bank_name": v.bank_name,
                "bank_holder": v.bank_holder,
                "status": _status_value(v.status),
                "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in items
        ]
    }


async def _do_detail(db: AsyncSession, verification_id: uuid.UUID) -> dict:
    result = await db.execute(
        select(BusinessVerification)
        .options(selectinload(BusinessVerification.documents))
        .where(BusinessVerification.id == verification_id)
        .limit(1)
    )
    ver = result.scalar_one_or_none()
    if ver is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"data": _serialize(ver)}


async def _do_review(
    db: AsyncSession,
    verification_id: uuid.UUID,
    action: str,
    reason: str | None,
    reviewer_id: uuid.UUID | None,
) -> dict:
    """승인/반려 상태전이 — admin/internal 공용.

    멱등/동시성: FOR UPDATE 로 행 잠금. pending 이 아니면 409(재심사 방지). 단일 커밋.
    """
    if action == "reject" and not (reason or "").strip():
        raise HTTPException(status_code=400, detail="반려 사유가 필요합니다")

    ver = (
        await db.execute(
            select(BusinessVerification)
            .where(BusinessVerification.id == verification_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if ver is None:
        raise HTTPException(status_code=404, detail="not found")
    if ver.status != BizVerificationStatus.PENDING:
        raise HTTPException(
            status_code=409, detail="심사 대기(pending) 상태만 승인/반려할 수 있습니다"
        )

    now = datetime.now(timezone.utc)
    if action == "approve":
        ver.status = BizVerificationStatus.APPROVED
        ver.rejected_reason = None
    else:
        ver.status = BizVerificationStatus.REJECTED
        ver.rejected_reason = reason
    ver.reviewed_by = reviewer_id
    ver.reviewed_at = now
    ver.updated_at = now

    await db.commit()
    return {
        "data": {
            "id": str(ver.id),
            "account_id": str(ver.go_account_id),
            "status": _status_value(ver.status),
        }
    }


# ── 내부(go 프록시) 심사 엔드포인트 ──────────────────────────────────────────
# go internal/business-verifications/* 가 이 경로로 프록시(admin 권한은 go 측 withRole).


@internal_router.get("/business-verifications")
async def internal_list_verifications(
    request: Request,
    status_filter: str = "pending",
    db: AsyncSession = Depends(get_db),
):
    return await _do_list(db, status_filter)


@internal_router.get("/business-verifications/{verification_id}")
async def internal_get_verification(
    request: Request,
    verification_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    return await _do_detail(db, verification_id)


class InternalReviewIn(ReviewIn):
    reviewer_id: uuid.UUID | None = None


@internal_router.patch("/business-verifications/{verification_id}")
async def internal_review_verification(
    request: Request,
    verification_id: uuid.UUID,
    body: InternalReviewIn,
    db: AsyncSession = Depends(get_db),
):
    return await _do_review(db, verification_id, body.action, body.reason, body.reviewer_id)


# ── admin(플랫폼 심사) 엔드포인트 ─────────────────────────────────────────────


@admin_router.get("/business-verifications")
async def admin_list_verifications(
    status_filter: str = "pending",
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """심사 대기열 — v2 admin 심사 UI. status(기본 pending)로 필터."""
    return await _do_list(db, status_filter)


@admin_router.get("/business-verifications/{verification_id}")
async def admin_get_verification(
    verification_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """심사 상세(서류 포함)."""
    return await _do_detail(db, verification_id)


@admin_router.patch("/business-verifications/{verification_id}")
async def admin_review_verification(
    verification_id: uuid.UUID,
    body: ReviewIn,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """승인/반려 — 상태머신 전이. 승인 시 게이트 해제(approved 원장).

    멱등/동시성: pending 이 아닌 행 재심사 방지(409), 반려 사유 필수, 단일 커밋.
    """
    return await _do_review(db, verification_id, body.action, body.reason, admin.id)
