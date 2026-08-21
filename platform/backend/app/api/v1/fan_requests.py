"""Fan request endpoints -- fans can request artists/events they want to see."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user, get_current_user_optional, get_current_admin
from app.models.fan_request_artist import FanRequestArtist
from app.models.fan_request import FanRequest
from app.models.user import User
from app.schemas.fan_request import (
    FanRequestArtistRanking,
    FanRequestRankingResponse,
    FanRequestArtistCreate,
    FanRequestArtistUpdate,
    MyFanRequestResponse,
)

router = APIRouter()
admin_router = APIRouter()


# ── Public / User endpoints ──────────────────────────────────────────


@router.get("/ranking", response_model=FanRequestRankingResponse)
async def get_fan_request_ranking(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    genre: str | None = None,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_read_db),
):
    """Get artist ranking by request count."""
    count_sub = (
        select(
            FanRequest.artist_id,
            func.count().label("request_count"),
        )
        .group_by(FanRequest.artist_id)
        .subquery()
    )

    query = (
        select(
            FanRequestArtist,
            func.coalesce(count_sub.c.request_count, 0).label("request_count"),
        )
        .outerjoin(count_sub, FanRequestArtist.id == count_sub.c.artist_id)
        .where(FanRequestArtist.is_active == True)  # noqa: E712
    )

    if genre:
        query = query.where(FanRequestArtist.genre == genre)

    # Featured first, then by count desc
    query = (
        query.order_by(
            FanRequestArtist.is_featured.desc(),
            func.coalesce(count_sub.c.request_count, 0).desc(),
            FanRequestArtist.created_at.desc(),
        )
        .offset(skip)
        .limit(limit)
    )

    result = await db.execute(query)
    rows = result.all()

    # Get user's requested artist ids
    user_requested_ids: set[uuid.UUID] = set()
    if user:
        user_req_result = await db.execute(
            select(FanRequest.artist_id).where(FanRequest.user_id == user.id)
        )
        user_requested_ids = {r[0] for r in user_req_result.all()}

    # Total count
    total_q = select(func.count()).select_from(FanRequestArtist).where(
        FanRequestArtist.is_active == True  # noqa: E712
    )
    if genre:
        total_q = total_q.where(FanRequestArtist.genre == genre)
    total = await db.scalar(total_q) or 0

    items = [
        FanRequestArtistRanking(
            id=artist.id,
            name=artist.name,
            image_url=artist.image_url,
            genre=artist.genre,
            is_featured=artist.is_featured,
            request_count=request_count,
            user_requested=artist.id in user_requested_ids,
        )
        for artist, request_count in rows
    ]

    return FanRequestRankingResponse(items=items, total=total)


@router.post("/{artist_id}", status_code=201)
async def create_fan_request(
    artist_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Request an artist (one per user per artist)."""
    # Check artist exists and is active
    artist_result = await db.execute(
        select(FanRequestArtist).where(
            FanRequestArtist.id == artist_id,
            FanRequestArtist.is_active == True,  # noqa: E712
        )
    )
    if not artist_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="아티스트를 찾을 수 없습니다")

    # Check duplicate
    existing = await db.execute(
        select(FanRequest).where(
            FanRequest.artist_id == artist_id,
            FanRequest.user_id == user.id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 요청한 아티스트입니다")

    fan_request = FanRequest(artist_id=artist_id, user_id=user.id)
    db.add(fan_request)
    await db.commit()
    return {"ok": True}


@router.delete("/{artist_id}", status_code=204)
async def delete_fan_request(
    artist_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a fan request."""
    result = await db.execute(
        select(FanRequest).where(
            FanRequest.artist_id == artist_id,
            FanRequest.user_id == user.id,
        )
    )
    fan_request = result.scalar_one_or_none()
    if not fan_request:
        raise HTTPException(status_code=404, detail="요청을 찾을 수 없습니다")

    await db.delete(fan_request)
    await db.commit()


@router.get("/me", response_model=list[MyFanRequestResponse])
async def get_my_fan_requests(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get current user's fan requests."""
    query = (
        select(FanRequest, FanRequestArtist)
        .join(FanRequestArtist, FanRequest.artist_id == FanRequestArtist.id)
        .where(FanRequest.user_id == user.id)
        .order_by(FanRequest.created_at.desc())
    )
    result = await db.execute(query)
    rows = result.all()

    return [
        MyFanRequestResponse(
            artist_id=artist.id,
            artist_name=artist.name,
            artist_image_url=artist.image_url,
            genre=artist.genre,
            created_at=req.created_at,
        )
        for req, artist in rows
    ]


# ── Admin endpoints ──────────────────────────────────────────────────


@admin_router.get("/fan-requests", response_model=FanRequestRankingResponse)
async def admin_get_fan_requests(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    include_inactive: bool = Query(False),
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Admin: get full ranking including inactive artists."""
    count_sub = (
        select(
            FanRequest.artist_id,
            func.count().label("request_count"),
        )
        .group_by(FanRequest.artist_id)
        .subquery()
    )

    query = select(
        FanRequestArtist,
        func.coalesce(count_sub.c.request_count, 0).label("request_count"),
    ).outerjoin(count_sub, FanRequestArtist.id == count_sub.c.artist_id)

    if not include_inactive:
        query = query.where(FanRequestArtist.is_active == True)  # noqa: E712

    query = (
        query.order_by(
            func.coalesce(count_sub.c.request_count, 0).desc(),
            FanRequestArtist.created_at.desc(),
        )
        .offset(skip)
        .limit(limit)
    )

    result = await db.execute(query)
    rows = result.all()

    total_q = select(func.count()).select_from(FanRequestArtist)
    if not include_inactive:
        total_q = total_q.where(FanRequestArtist.is_active == True)  # noqa: E712
    total = await db.scalar(total_q) or 0

    items = [
        FanRequestArtistRanking(
            id=artist.id,
            name=artist.name,
            image_url=artist.image_url,
            genre=artist.genre,
            is_featured=artist.is_featured,
            request_count=request_count,
        )
        for artist, request_count in rows
    ]

    return FanRequestRankingResponse(items=items, total=total)


@admin_router.patch("/fan-requests/{artist_id}")
async def admin_update_fan_request_artist(
    artist_id: uuid.UUID,
    data: FanRequestArtistUpdate,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: update artist featured/active status."""
    result = await db.execute(
        select(FanRequestArtist).where(FanRequestArtist.id == artist_id)
    )
    artist = result.scalar_one_or_none()
    if not artist:
        raise HTTPException(status_code=404, detail="아티스트를 찾을 수 없습니다")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(artist, field, value)

    await db.commit()
    await db.refresh(artist)
    return {"ok": True, "id": str(artist.id)}


@admin_router.post("/fan-requests/artists", status_code=201)
async def admin_create_fan_request_artist(
    data: FanRequestArtistCreate,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: create a new artist for fan requests."""
    # Check duplicate name
    existing = await db.execute(
        select(FanRequestArtist).where(FanRequestArtist.name == data.name)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 등록된 아티스트입니다")

    artist = FanRequestArtist(
        name=data.name,
        image_url=data.image_url,
        genre=data.genre,
        is_featured=data.is_featured,
    )
    db.add(artist)
    await db.commit()
    await db.refresh(artist)
    return {"ok": True, "id": str(artist.id)}
