"""Fanclub management endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_user, get_current_organizer
from app.models.user import User
from app.schemas.fanclub import (
    FanclubCreate,
    FanclubUpdate,
    FanclubResponse,
    FanclubListResponse,
    MembershipJoinRequest,
    MembershipResponse,
    MemberListResponse,
    BulkImportRequest,
    BulkImportResponse,
)
from app.services.fanclub_service import FanclubService

router = APIRouter()


@router.get("/", response_model=FanclubListResponse)
async def list_fanclubs(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """List all active fanclubs (public)."""
    svc = FanclubService(db)
    fanclubs, total = await svc.list_fanclubs(skip=skip, limit=limit)
    items = []
    for fc in fanclubs:
        count = await svc.get_member_count(fc.id)
        resp = FanclubResponse.model_validate(fc)
        resp.member_count = count
        items.append(resp)
    return FanclubListResponse(fanclubs=items, total=total)


@router.get("/{fanclub_id}", response_model=FanclubResponse)
async def get_fanclub(
    fanclub_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """Get fanclub detail."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc:
        raise HTTPException(status_code=404, detail="커뮤니티를 찾을 수 없습니다.")
    count = await svc.get_member_count(fc.id)
    resp = FanclubResponse.model_validate(fc)
    resp.member_count = count
    return resp


@router.post("/", response_model=FanclubResponse, status_code=status.HTTP_201_CREATED)
async def create_fanclub(
    data: FanclubCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a new fanclub (organizer only)."""
    svc = FanclubService(db)
    fc = await svc.create_fanclub(user.id, data.model_dump())
    await db.commit()
    resp = FanclubResponse.model_validate(fc)
    resp.member_count = 0
    return resp


@router.put("/{fanclub_id}", response_model=FanclubResponse)
async def update_fanclub(
    fanclub_id: uuid.UUID,
    data: FanclubUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update fanclub info (owner only)."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc:
        raise HTTPException(status_code=404, detail="커뮤니티를 찾을 수 없습니다.")
    if fc.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(fc, key, value)
    await db.commit()

    count = await svc.get_member_count(fc.id)
    resp = FanclubResponse.model_validate(fc)
    resp.member_count = count
    return resp


@router.get("/{fanclub_id}/members", response_model=MemberListResponse)
async def list_members(
    fanclub_id: uuid.UUID,
    status_filter: str | None = Query(None, alias="status"),
    tier: str | None = None,
    search: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List fanclub members (owner only)."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc or fc.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    skip = (page - 1) * page_size
    members, total = await svc.list_members(
        fanclub_id,
        status=status_filter,
        tier=tier,
        search=search,
        skip=skip,
        limit=page_size,
    )
    items = []
    for m in members:
        membership = m["membership"]
        items.append(
            MembershipResponse(
                id=membership.id,
                user_id=membership.user_id,
                user_name=m["user_name"],
                user_email=m["user_email"],
                fanclub_id=membership.fanclub_id,
                fanclub_name=fc.name,
                artist_name=fc.artist_name,
                tier=membership.tier,
                status=membership.status,
                membership_code=membership.membership_code,
                verified_at=membership.verified_at,
                expires_at=membership.expires_at,
                joined_at=membership.joined_at,
            )
        )
    return MemberListResponse(
        members=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "/{fanclub_id}/join", response_model=MembershipResponse, status_code=status.HTTP_201_CREATED
)
async def join_fanclub(
    fanclub_id: uuid.UUID,
    data: MembershipJoinRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Join a fanclub with membership code."""
    svc = FanclubService(db)
    try:
        membership = await svc.join_fanclub(
            user.id,
            fanclub_id,
            data.membership_code,
            data.tier,
        )
        await db.commit()

        # AP 적립: 팬클럽 가입 인증 1,000AP
        try:
            from app.services.point_service import PointService
            from app.models.point import PointType, PointTransactionType
            ps = PointService(db)
            await ps.earn(
                user_id=user.id,
                point_type=PointType.FAN,
                amount=1000,
                tx_type=PointTransactionType.EARN_FANCLUB,
                reference_id=fanclub_id,
                description="팬클럽 가입 인증 (1,000AP)",
            )
            await db.commit()
        except Exception:
            pass
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "팬클럽 처리 중 오류가 발생했습니다"))

    fc = await svc.get_fanclub(fanclub_id)
    return MembershipResponse(
        id=membership.id,
        user_id=membership.user_id,
        user_name=user.name,
        fanclub_id=membership.fanclub_id,
        fanclub_name=fc.name if fc else "",
        artist_name=fc.artist_name if fc else "",
        tier=membership.tier,
        status=membership.status,
        verified_at=membership.verified_at,
        expires_at=membership.expires_at,
        joined_at=membership.joined_at,
    )


@router.post("/{fanclub_id}/verify/{membership_id}", response_model=MembershipResponse)
async def verify_membership(
    fanclub_id: uuid.UUID,
    membership_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Verify a pending membership (owner only)."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc or fc.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")
    try:
        membership = await svc.verify_membership(membership_id)
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=client_error_detail(e, "팬클럽 처리 중 오류가 발생했습니다"))

    return MembershipResponse(
        id=membership.id,
        user_id=membership.user_id,
        fanclub_id=membership.fanclub_id,
        fanclub_name=fc.name,
        artist_name=fc.artist_name,
        tier=membership.tier,
        status=membership.status,
        verified_at=membership.verified_at,
        expires_at=membership.expires_at,
        joined_at=membership.joined_at,
    )


@router.post("/{fanclub_id}/bulk-import", response_model=BulkImportResponse)
async def bulk_import_members(
    fanclub_id: uuid.UUID,
    data: BulkImportRequest,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Bulk import fanclub members via list (owner only)."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc or fc.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    result = await svc.bulk_import_members(fanclub_id, [e.model_dump() for e in data.entries])
    await db.commit()
    return BulkImportResponse(**result)


@router.delete("/{fanclub_id}/members/{user_id}", status_code=status.HTTP_200_OK)
async def remove_member(
    fanclub_id: uuid.UUID,
    user_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Remove a member from fanclub (owner only)."""
    svc = FanclubService(db)
    fc = await svc.get_fanclub(fanclub_id)
    if not fc or fc.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    await svc.remove_member(fanclub_id, user_id)
    await db.commit()
    return {"detail": "회원이 제거되었습니다."}
