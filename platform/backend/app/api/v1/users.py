"""User profile, bid history, statistics, GDPR/PIPA endpoints."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.core.audit import write_audit_log
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.user_preference import UserPreference
from app.models.bid import Bid, BidStatus
from app.models.event import Event, SeatTier
from app.models.allocation import AllocationResult
from app.models.lottery import LotteryEntry, LotteryPool
from app.models.interaction import UserInteraction, InteractionType
from app.schemas.user import UserProfile, UserUpdate, BidHistoryItem, UserStats, UserPreferenceUpdate, UserPreferenceResponse
from app.api.v1.events import strip_hidden_seat_tiers
from app.schemas.event import EventResponse
from app.schemas.checkin_ops import NoShowHistoryResponse
from app.services.fanclub_service import FanclubService
from app.services.gdpr_service import GDPRService
from app.services.checkin_service import CheckInService
from app.services.tier_service import TierService, TIER_THRESHOLDS
from talkfile_engine.fan_weight import (
    compute_fan_weight_v2,
    compute_behavior_score,
    FanScores,
    compute_raw_score,
    EVENT_TEMPLATES,
    EventType,
)

router = APIRouter()


class TierResponse(BaseModel):
    """멤버십 티어 응답 스키마."""

    tier: str
    tier_score: float
    multiplier: float
    next_tier: str | None = None
    next_threshold: float | None = None
    tier_updated_at: str | None = None

    model_config = ConfigDict(from_attributes=True)


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ensure_naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _build_fan_scores(user: User) -> FanScores:
    """Build FanScores from User model for v2 fan weight."""
    days_since_signup = (_utcnow() - _ensure_naive(user.created_at)).days

    # Freshness: linear decay over 180 days
    freshness = max(0.0, 1.0 - days_since_signup / 180.0) if days_since_signup < 180 else 0.0

    behavior = compute_behavior_score(
        no_show_rate=user.no_show_rate,
        cancel_rate=user.cancel_rate,
        dispute_rate=user.dispute_rate,
    )

    return FanScores(
        loyalty=user.loyalty_score,
        history=user.history_score,
        fanclub=1.0 if user.is_fanclub_member else 0.0,
        behavior=behavior,
        freshness=freshness,
    )


def _compute_fan_weight_breakdown(user: User) -> dict:
    """Compute per-dimension breakdown of fan weight contributions."""
    scores = _build_fan_scores(user)
    alphas = EVENT_TEMPLATES[EventType.GENERAL_CONCERT]

    return {
        "loyalty": {
            "score": scores.loyalty,
            "alpha": alphas.loyalty,
            "contribution": scores.loyalty * alphas.loyalty,
        },
        "history": {
            "score": scores.history,
            "alpha": alphas.history,
            "contribution": scores.history * alphas.history,
        },
        "fanclub": {
            "score": scores.fanclub,
            "alpha": alphas.fanclub,
            "contribution": scores.fanclub * alphas.fanclub,
        },
        "behavior": {
            "score": scores.behavior,
            "alpha": alphas.behavior,
            "contribution": scores.behavior * alphas.behavior,
        },
        "freshness": {
            "score": scores.freshness,
            "alpha": alphas.freshness,
            "contribution": scores.freshness * alphas.freshness,
        },
        "raw_score": compute_raw_score(scores, alphas),
    }


@router.get("/{user_id}/noshow-history", response_model=NoShowHistoryResponse)
async def get_noshow_history(
    user_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return no-show history and current penalty window for a user."""
    target_user_id = uuid.UUID(user_id)
    if not current_user.is_admin and current_user.id != target_user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    service = CheckInService(db)
    return await service.get_noshow_history(target_user_id)


@router.get("/me", response_model=UserProfile, response_model_exclude_none=True)
async def get_current_user_profile(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get current user profile with computed fan weight."""
    result = await db.execute(select(User).where(User.id == user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    fan_scores = _build_fan_scores(user)
    fan_weight = compute_fan_weight_v2(fan_scores)
    breakdown = _compute_fan_weight_breakdown(user)

    return UserProfile(
        id=user.id,
        email=user.email,
        name=user.name,
        phone=user.phone,
        is_verified=user.is_verified,
        is_organizer=user.is_organizer,
        is_admin=user.is_admin if user.is_admin else None,
        admin_role=getattr(user, "admin_role", None) if user.is_admin else None,
        verification_level=user.verification_level,
        loyalty_score=user.loyalty_score,
        history_score=user.history_score,
        is_fanclub_member=user.is_fanclub_member,
        no_show_rate=user.no_show_rate,
        cancel_rate=user.cancel_rate,
        dispute_rate=user.dispute_rate,
        fan_weight=fan_weight,
        fan_weight_breakdown=breakdown,
        avatar_url=getattr(user, "avatar_url", None),
        bio=getattr(user, "bio", None),
        preferred_language=getattr(user, "preferred_language", "ko"),
        timezone=getattr(user, "timezone", "Asia/Seoul"),
        created_at=user.created_at,
    )


@router.get("/me/tier", response_model=TierResponse)
async def get_my_tier(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """현재 사용자의 멤버십 티어 정보."""
    tier_svc = TierService(db)
    tier = await tier_svc.get_tier(user.id)
    score = await tier_svc.compute_tier_score(user.id)
    multiplier = await tier_svc.get_tier_multiplier(user.id)

    # Find next tier
    tier_order = ["rookie", "fan", "supporter", "corefan", "legend"]
    idx = tier_order.index(tier) if tier in tier_order else 0
    next_tier = tier_order[idx + 1] if idx < len(tier_order) - 1 else None
    next_threshold = TIER_THRESHOLDS[next_tier][0] if next_tier else None

    return TierResponse(
        tier=tier,
        tier_score=score,
        multiplier=multiplier,
        next_tier=next_tier,
        next_threshold=next_threshold,
        tier_updated_at=user.tier_updated_at.isoformat() if user.tier_updated_at else None,
    )


@router.patch("/me", response_model=UserProfile, response_model_exclude_none=True)
async def update_current_user_profile(
    data: UserUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update current user profile (name, phone)."""
    update_data = data.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Sanitize plain-text fields to prevent stored XSS
    for field in ("name", "bio"):
        if field in update_data and update_data[field] is not None:
            update_data[field] = sanitize_plain_text(update_data[field])

    old_values = {field: getattr(user, field, None) for field in update_data}
    for field, value in update_data.items():
        setattr(user, field, value)

    await write_audit_log(
        db,
        actor_id=user.id,
        action="user.profile_update",
        resource_type="user",
        resource_id=str(user.id),
        old_value=old_values,
        new_value=update_data,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    await db.refresh(user)

    fan_scores = _build_fan_scores(user)
    fan_weight = compute_fan_weight_v2(fan_scores)
    breakdown = _compute_fan_weight_breakdown(user)

    return UserProfile(
        id=user.id,
        email=user.email,
        name=user.name,
        phone=user.phone,
        is_verified=user.is_verified,
        is_organizer=user.is_organizer,
        is_admin=user.is_admin if user.is_admin else None,
        admin_role=getattr(user, "admin_role", None) if user.is_admin else None,
        verification_level=user.verification_level,
        loyalty_score=user.loyalty_score,
        history_score=user.history_score,
        is_fanclub_member=user.is_fanclub_member,
        no_show_rate=user.no_show_rate,
        cancel_rate=user.cancel_rate,
        dispute_rate=user.dispute_rate,
        fan_weight=fan_weight,
        fan_weight_breakdown=breakdown,
        avatar_url=getattr(user, "avatar_url", None),
        bio=getattr(user, "bio", None),
        preferred_language=getattr(user, "preferred_language", "ko"),
        timezone=getattr(user, "timezone", "Asia/Seoul"),
        created_at=user.created_at,
    )


@router.get("/me/fanclubs")
async def get_my_fanclubs(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get current user's fanclub memberships."""
    svc = FanclubService(db)
    return await svc.get_user_memberships(user.id)


@router.get("/me/bids", response_model=list[BidHistoryItem])
async def get_bid_history(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get bid history with event info (Bids + Lottery entries, merged by date)."""
    items: list[BidHistoryItem] = []

    # 1. Auction bids (Bid + Event join)
    bid_result = await db.execute(
        select(Bid, Event)
        .join(Event, Bid.event_id == Event.id)
        .where(Bid.user_id == user.id)
        .order_by(Bid.created_at.desc())
    )
    for bid, event in bid_result.all():
        final_price = None
        fair_price = None
        externality = None

        if bid.status == BidStatus.WON:
            alloc_result = await db.execute(
                select(AllocationResult).where(
                    AllocationResult.bid_id == bid.id,
                    AllocationResult.user_id == user.id,
                )
            )
            ar = alloc_result.scalar_one_or_none()
            if ar:
                final_price = ar.final_price
                fair_price = ar.vcg_price  # DB 컬럼명 유지
                externality = ar.externality

        items.append(
            BidHistoryItem(
                id=bid.id,
                bid_id=bid.id,
                event_id=event.id,
                event_title=event.title,
                event_date=event.event_date,
                event_venue=event.venue,
                max_willingness_to_pay=bid.max_willingness_to_pay,
                quantity=bid.quantity,
                status=bid.status.value,
                sale_mode="point_lottery",
                effective_weight=bid.effective_weight,
                final_price=final_price,
                fair_price=fair_price,
                externality=externality,
                created_at=bid.created_at,
            )
        )

    # 2. Lottery entries (LotteryEntry + LotteryPool + Event + SeatTier join)
    lottery_result = await db.execute(
        select(LotteryEntry, LotteryPool, Event, SeatTier)
        .join(LotteryPool, LotteryEntry.pool_id == LotteryPool.id)
        .join(Event, LotteryPool.event_id == Event.id)
        .join(SeatTier, LotteryPool.tier_id == SeatTier.id)
        .where(LotteryEntry.user_id == user.id)
        .order_by(LotteryEntry.created_at.desc())
    )
    for entry, pool, event, tier in lottery_result.all():
        items.append(
            BidHistoryItem(
                id=entry.id,
                event_id=event.id,
                event_title=event.title,
                event_date=event.event_date,
                event_venue=event.venue,
                max_willingness_to_pay=float(tier.base_price),
                quantity=entry.group_size,
                status=entry.result.value if hasattr(entry.result, "value") else str(entry.result),
                sale_mode="point_lottery",
                effective_weight=entry.fan_weight,
                invested_ap=entry.invested_ap,
                created_at=entry.created_at,
            )
        )

    # Sort merged list by date desc, then paginate
    items.sort(key=lambda x: x.created_at, reverse=True)
    return items[skip : skip + limit]


@router.get("/me/stats", response_model=UserStats)
async def get_user_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get user statistics (total bids, wins, losses, avg savings)."""
    # Total bids (excluding cancelled)
    total_bids_result = await db.execute(
        select(func.count(Bid.id)).where(
            Bid.user_id == user.id,
            Bid.status != BidStatus.CANCELLED,
        )
    )
    total_bids = total_bids_result.scalar() or 0

    # Total wins
    total_wins_result = await db.execute(
        select(func.count(Bid.id)).where(
            Bid.user_id == user.id,
            Bid.status == BidStatus.WON,
        )
    )
    total_wins = total_wins_result.scalar() or 0

    # Total losses
    total_losses_result = await db.execute(
        select(func.count(Bid.id)).where(
            Bid.user_id == user.id,
            Bid.status == BidStatus.LOST,
        )
    )
    total_losses = total_losses_result.scalar() or 0

    # Win rate
    win_rate = (total_wins / total_bids) if total_bids > 0 else 0.0

    # Compute savings: for each won bid, savings = bid_price - final_price
    # Join Bid with AllocationResult to get final_price
    savings_result = await db.execute(
        select(
            Bid.max_willingness_to_pay,
            AllocationResult.final_price,
        )
        .join(
            AllocationResult,
            and_(
                AllocationResult.bid_id == Bid.id,
                AllocationResult.user_id == Bid.user_id,
            ),
        )
        .where(
            Bid.user_id == user.id,
            Bid.status == BidStatus.WON,
        )
    )
    savings_rows = savings_result.all()

    total_savings = 0.0
    for bid_price, final_price in savings_rows:
        total_savings += max(0.0, bid_price - final_price)

    avg_savings = (total_savings / len(savings_rows)) if savings_rows else 0.0

    return UserStats(
        total_bids=total_bids,
        total_wins=total_wins,
        total_losses=total_losses,
        win_rate=round(win_rate, 4),
        avg_savings=round(avg_savings, 2),
        total_savings=round(total_savings, 2),
    )


@router.get("/me/favorites", response_model=list[EventResponse])
async def list_user_favorites(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List current user's favorited events."""
    fav_result = await db.execute(
        select(UserInteraction.event_id)
        .where(
            UserInteraction.user_id == user.id,
            UserInteraction.interaction_type == InteractionType.FAVORITE.value,
        )
        .order_by(UserInteraction.created_at.desc())
    )
    fav_event_ids = set()
    for row in fav_result.all():
        if row[0] is not None:
            fav_event_ids.add(row[0])

    # Remove unfavorited
    unfav_result = await db.execute(
        select(UserInteraction.event_id).where(
            UserInteraction.user_id == user.id,
            UserInteraction.interaction_type == InteractionType.UNFAVORITE.value,
        )
    )
    unfav_event_ids = set()
    for row in unfav_result.all():
        if row[0] is not None:
            unfav_event_ids.add(row[0])

    active_fav_ids = fav_event_ids - unfav_event_ids

    if not active_fav_ids:
        return []

    result = await db.execute(
        select(Event)
        .where(Event.id.in_(active_fav_ids))
        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
    )
    events = result.scalars().all()
    # 🔴 즐겨찾기도 숨김 티어를 내보내면 안 된다(회원이라고 볼 수 있는 게 아니다)
    return [strip_hidden_seat_tiers(EventResponse.model_validate(e), e) for e in events]


# ════════════════════════════════════════════════════════════════════
# GDPR/PIPA: 계정 삭제, 데이터 내보내기, 동의 관리
# ════════════════════════════════════════════════════════════════════


class ConsentUpdate(BaseModel):
    purpose: str
    consented: bool


@router.delete("/me")
async def request_account_deletion(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """계정 삭제 요청 (30일 유예 기간)."""
    svc = GDPRService(db)
    try:
        result = await svc.request_account_deletion(user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await write_audit_log(
        db,
        actor_id=user.id,
        action="account.deletion_requested",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    return result


@router.post("/me/cancel-deletion")
async def cancel_account_deletion(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """계정 삭제 요청 취소 (유예 기간 내)."""
    svc = GDPRService(db)
    try:
        result = await svc.cancel_account_deletion(user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await write_audit_log(
        db,
        actor_id=user.id,
        action="account.deletion_cancelled",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    return result


@router.get("/me/data-export")
async def export_my_data(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """GDPR 데이터 이식성 — 사용자 전체 데이터 JSON 다운로드."""
    svc = GDPRService(db)
    try:
        data = await svc.export_user_data(user.id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return JSONResponse(
        content=data,
        headers={"Content-Disposition": f'attachment; filename="pickket_data_{user.id}.json"'},
    )


@router.get("/me/consents")
async def get_my_consents(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """동의 목록 조회."""
    svc = GDPRService(db)
    return await svc.get_consents(user.id)


@router.put("/me/consents")
async def update_my_consent(
    data: ConsentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """동의 업데이트."""
    valid_purposes = {"marketing", "analytics", "third_party"}
    if data.purpose not in valid_purposes:
        raise HTTPException(
            status_code=400,
            detail=f"유효하지 않은 목적입니다. 허용: {', '.join(valid_purposes)}",
        )

    ip = request.client.host if request.client else None
    svc = GDPRService(db)
    result = await svc.update_consent(user.id, data.purpose, data.consented, ip)

    await write_audit_log(
        db,
        actor_id=user.id,
        action="user.consent_update",
        resource_type="user",
        resource_id=str(user.id),
        new_value={"purpose": data.purpose, "consented": data.consented},
        ip_address=ip,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()
    return result


# ── 비밀번호 변경 ──

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/me/change-password")
async def change_password(
    data: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """로그인 상태에서 비밀번호 변경."""
    from app.core.security import verify_password, hash_password

    if not verify_password(data.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="현재 비밀번호가 올바르지 않습니다")

    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="새 비밀번호는 8자 이상이어야 합니다")

    user.hashed_password = hash_password(data.new_password)
    await db.commit()

    return {"message": "비밀번호가 변경되었습니다"}


# ── 온보딩 취향 (user_preferences) — app 404 유실 차단 ──
async def _load_pref(db: AsyncSession, user_id) -> UserPreference | None:
    return (
        await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))
    ).scalar_one_or_none()


@router.get("/me/preferences", response_model=UserPreferenceResponse)
async def get_my_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """현재 사용자 온보딩 취향 조회."""
    pref = await _load_pref(db, user.id)
    if pref is None:
        return UserPreferenceResponse()
    return UserPreferenceResponse(
        genres=pref.genres or [],
        artist_ids=pref.artist_ids or [],
        categories=pref.categories or [],
    )


@router.post("/me/preferences", response_model=UserPreferenceResponse)
async def upsert_my_preferences(
    data: UserPreferenceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """온보딩 취향 upsert (genres/artist_ids/categories). app 온보딩에서 호출."""
    pref = await _load_pref(db, user.id)
    if pref is None:
        pref = UserPreference(user_id=user.id)
        db.add(pref)
    if data.genres is not None:
        pref.genres = data.genres
    if data.artist_ids is not None:
        pref.artist_ids = data.artist_ids
    if data.categories is not None:
        pref.categories = data.categories
    await db.commit()
    return UserPreferenceResponse(
        genres=pref.genres or [],
        artist_ids=pref.artist_ids or [],
        categories=pref.categories or [],
    )
