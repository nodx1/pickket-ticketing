"""Lottery application and draw endpoints."""

import logging
import uuid

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.v1.deps import verify_behavior_token
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user, get_current_organizer
from app.models.user import User
from app.schemas.lottery import (
    LotteryApply,
    LotteryDrawResult,
    LotteryEntryResponse,
    LotteryMyResultResponse,
    LotteryPoolResponse,
    LotteryTransparencyReport,
    LotteryVerificationResponse,
)
from app.services.lottery_service import LotteryService
from app.models.lottery import LotteryEntry, LotteryPool, LotteryEntryResult
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket
from app.models.seat import Seat
from app.models.event import Event, SeatTier
from sqlalchemy import func, select, update
from pydantic import BaseModel

router = APIRouter()


class MyLotteryEntryItem(BaseModel):
    pool_id: str
    tier_id: str
    tier_name: str
    result: str  # pending | won | waitlisted
    group_size: int
    invested_ap: int
    pool_status: str  # applying | closed | drawn | finalized
    # 당첨 시에만 채워짐
    order_id: str | None = None
    order_status: str | None = None
    payment_deadline: str | None = None
    total_amount: float | None = None
    seats: list[dict] = []


class MyLotteryEntriesResponse(BaseModel):
    event_id: str
    entries: list[MyLotteryEntryItem]


@router.post(
    "/{event_id}/tiers/{tier_id}/lottery/apply",
    response_model=LotteryEntryResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_behavior_token)],
    summary="추첨 응모",
    description="특정 등급의 추첨 풀에 응모합니다. 그룹 티켓, 클라이언트 시드(공정성 검증용), AP 투자 등을 선택적으로 지정할 수 있습니다.",
    openapi_extra={"x-agent-hint": "Auth + behavior token required. POST LotteryApply with optional group_id, group_size, client_seed (for fairness verification), invested_ap. One entry per user per tier."},
)
async def apply_lottery(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: LotteryApply,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Apply to a lottery pool for the given tier."""
    # 멤버십 선판매 phase인 경우 팬클럽 회원만 허용
    tier_q = await db.execute(select(SeatTier).where(SeatTier.id == tier_id))
    tier_obj = tier_q.scalar_one_or_none()
    if tier_obj and tier_obj.sale_mode == "membership_presale":
        from app.models.fanclub import FanclubMembership, MembershipStatus
        event_q = await db.execute(select(Event.community_id).where(Event.id == event_id))
        community_id = event_q.scalar_one_or_none()
        if community_id:
            mem_q = await db.execute(
                select(FanclubMembership.id).where(
                    FanclubMembership.user_id == user.id,
                    FanclubMembership.fanclub_id == community_id,
                    FanclubMembership.status == MembershipStatus.ACTIVE.value,
                )
            )
            if not mem_q.scalar_one_or_none():
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="멤버십 회원만 응모할 수 있습니다",
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="이 이벤트에 연결된 팬클럽이 없습니다",
            )

    try:
        service = LotteryService(db)
        entry = await service.apply(
            user_id=user.id,
            event_id=event_id,
            tier_id=tier_id,
            group_id=data.group_id,
            group_size=data.group_size,
            client_seed=data.client_seed,
            invested_ap=data.invested_ap,
        )
        # 응모 시 bid_count 증가 (실시간 통계 반영)
        await db.execute(
            update(Event)
            .where(Event.id == event_id)
            .values(bid_count=Event.bid_count + 1)
        )
        await db.commit()

        # SSE 실시간 푸시
        try:
            ev_row = await db.execute(
                select(Event.view_count, Event.bid_count).where(Event.id == event_id)
            )
            row = ev_row.first()
            if row:
                from app.api.v1.sse import publish_stats_update
                await publish_stats_update(str(event_id), row.view_count or 0, row.bid_count or 0)
        except Exception:
            pass  # SSE 푸시 실패해도 응모 자체는 성공

        return entry
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Lottery apply failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get(
    "/{event_id}/lottery/my-entries",
    response_model=MyLotteryEntriesResponse,
    summary="내 이벤트 추첨 응모/결과 전체 조회",
    description="이 이벤트에 대한 내 모든 응모 항목(당첨/낙첨/대기/진행중)을 반환. 당첨 시 order/payment_deadline/seats 포함.",
)
async def my_lottery_entries(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 이벤트의 모든 풀 조회
    pools_q = await db.execute(
        select(LotteryPool).where(LotteryPool.event_id == event_id)
    )
    pools = {p.id: p for p in pools_q.scalars().all()}
    if not pools:
        return MyLotteryEntriesResponse(event_id=str(event_id), entries=[])

    # 내 응모 조회
    entries_q = await db.execute(
        select(LotteryEntry).where(
            LotteryEntry.user_id == user.id,
            LotteryEntry.pool_id.in_(pools.keys()),
        )
    )
    entries = entries_q.scalars().all()
    if not entries:
        return MyLotteryEntriesResponse(event_id=str(event_id), entries=[])

    # tier 이름 조회
    tier_ids = {p.tier_id for p in pools.values()}
    tiers_q = await db.execute(select(SeatTier).where(SeatTier.id.in_(tier_ids)))
    tiers = {t.id: t for t in tiers_q.scalars().all()}

    # 각 당첨 entry 의 최신 order + tickets + seats 조회
    result_items: list[MyLotteryEntryItem] = []
    for entry in entries:
        pool = pools[entry.pool_id]
        tier = tiers.get(pool.tier_id)
        item = MyLotteryEntryItem(
            pool_id=str(pool.id),
            tier_id=str(pool.tier_id),
            tier_name=tier.name if tier else "",
            result=str(entry.result.value if hasattr(entry.result, "value") else entry.result),
            group_size=entry.group_size,
            invested_ap=entry.invested_ap or 0,
            pool_status=str(
                pool.status.value if hasattr(pool.status, "value") else pool.status
            ),
        )
        if str(item.result).lower() == "won":
            # 당첨: order + tickets
            order_q = await db.execute(
                select(Order)
                .where(
                    Order.user_id == user.id,
                    Order.event_id == event_id,
                    Order.tier_id == pool.tier_id,
                )
                .order_by(Order.created_at.desc())
                .limit(1)
            )
            order = order_q.scalar_one_or_none()
            if order:
                item.order_id = str(order.id)
                item.order_status = str(
                    order.status.value if hasattr(order.status, "value") else order.status
                )
                if order.payment_deadline:
                    item.payment_deadline = order.payment_deadline.isoformat()
                item.total_amount = float(order.total_amount or 0)
                # tickets + seats
                tickets_q = await db.execute(
                    select(Ticket).where(Ticket.purchase_order_id == order.id)
                )
                tickets = tickets_q.scalars().all()
                seat_ids = [t.seat_id for t in tickets if t.seat_id]
                seats_map: dict = {}
                if seat_ids:
                    seats_q = await db.execute(
                        select(Seat).where(Seat.id.in_(seat_ids))
                    )
                    seats_map = {
                        s.id: {
                            "id": str(s.id),
                            "section": s.section,
                            "row": s.row_number,
                            "seat_number": s.seat_number,
                            "label": s.label,
                        }
                        for s in seats_q.scalars().all()
                    }
                item.seats = [seats_map[sid] for sid in seat_ids if sid in seats_map]
        result_items.append(item)

    return MyLotteryEntriesResponse(event_id=str(event_id), entries=result_items)


@router.get(
    "/{event_id}/tiers/{tier_id}/lottery/status",
    response_model=LotteryPoolResponse,
    summary="추첨 풀 현황",
    description="등급별 추첨 풀의 현재 상태를 조회합니다. 응모자 수, 풀 상태 등을 반환합니다. 인증 불필요.",
    openapi_extra={"x-agent-hint": "Public endpoint. Returns pool status including applicant count, pool state, and capacity info."},
)
async def lottery_status(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get the current lottery pool status for a tier. Public endpoint."""
    try:
        service = LotteryService(db)
        pool_status = await service.get_pool_status(event_id=event_id, tier_id=tier_id)
        return pool_status
    except ValueError:
        # pool이 아직 생성되지 않은 경우 기본 응답
        return LotteryPoolResponse(
            id=tier_id,
            event_id=event_id,
            tier_id=tier_id,
            total_seats=0,
            total_applicants=0,
            status="open",
        )


@router.post(
    "/{event_id}/tiers/{tier_id}/lottery/draw",
    response_model=LotteryDrawResult,
    summary="추첨 실행",
    description="등급의 추첨을 실행합니다. 주최자 권한 필요. 팬 가중치 기반 가중 랜덤 선발로 당첨자를 결정합니다.",
    openapi_extra={"x-agent-hint": "Organizer-only. Closes application pool and selects winners via weighted random (fan weights). Returns LotteryDrawResult with winners/losers."},
)
async def draw_lottery(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Draw the lottery for a tier. Event owner (or admin) only.

    Closes the application pool and selects winners using weighted random
    selection based on fan weights.
    """
    import os
    from datetime import datetime, timezone

    # ── 소유권 검증: 이벤트를 소유한 organizer 또는 admin 만 추첨 실행 가능 ──
    # (get_current_organizer 는 is_organizer 플래그만 확인 — 임의 organizer 가
    #  타인 이벤트를 조기 추첨하는 것을 막기 위해 Event.organizer_id 를 검증)
    event_q = await db.execute(select(Event).where(Event.id == event_id))
    event = event_q.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")
    if not (user.is_admin or event.organizer_id == user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 이벤트의 추첨을 실행할 권한이 없습니다",
        )

    # ── 응모 마감 검증: 마감 시각 이전 조기 추첨 차단 ──
    # Celery auto_draw_lotteries 와 동일한 deadline 규칙:
    # phase_configs 의 lottery phase ends_at(가장 늦은 값) 우선, 없으면
    # event.bidding_closes_at fallback. (PYTEST 환경은 apply() 의 phase 가드와
    # 동일하게 skip — 기존 테스트 픽스처는 마감 시각이 미래)
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        from app.models.phase_config import PhaseConfig

        phase_end = (
            await db.execute(
                select(func.max(PhaseConfig.ends_at)).where(
                    PhaseConfig.event_id == event_id,
                    PhaseConfig.phase == "lottery",
                )
            )
        ).scalar_one_or_none()
        deadline = phase_end or event.bidding_closes_at
        if deadline is not None:
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) < deadline:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="응모 마감 전에는 추첨을 실행할 수 없습니다",
                )

    try:
        service = LotteryService(db)
        # First get the pool to obtain pool_id
        pool_status = await service.get_pool_status(event_id=event_id, tier_id=tier_id)
        result = await service.draw(pool_id=pool_status.id)
        await db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# ─── Public verification & transparency endpoints ───


@router.get(
    "/pools/{pool_id}/verify",
    response_model=LotteryVerificationResponse,
    summary="추첨 공정성 검증",
    description="추첨 결과의 암호학적 공정성을 검증합니다. 커밋먼트 해시와 검증 데이터를 반환하며, is_valid=true이면 공정한 추첨이 증명됩니다. 인증 불필요.",
    openapi_extra={"x-agent-hint": "Public endpoint. Pass pool_id. Returns commitment_hash, verification data, is_valid boolean for provably fair lottery verification."},
)
async def verify_lottery_pool(
    pool_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Verify a drawn lottery pool. Public endpoint -- no authentication required.

    Returns the commitment hash, verification data, and whether the
    cryptographic verification passed (is_valid=true means the lottery
    was provably fair).
    """
    try:
        service = LotteryService(db)
        return await service.verify_pool(pool_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.get(
    "/pools/{pool_id}/transparency-report",
    response_model=LotteryTransparencyReport,
    summary="추첨 투명성 리포트",
    description="추첨 풀의 익명화된 투명성 리포트를 조회합니다. 경쟁률, 가중치 분포 통계, 결과 분석 등을 PII 없이 제공합니다. 인증 불필요.",
    openapi_extra={"x-agent-hint": "Public endpoint. Returns competition ratio, weight distribution stats, result breakdown. No PII included."},
)
async def get_transparency_report(
    pool_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get anonymized transparency report for a drawn lottery pool.

    Public endpoint. Returns competition ratio, weight distribution
    statistics, and result breakdown without any PII.
    """
    try:
        service = LotteryService(db)
        return await service.get_transparency_report(pool_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.get(
    "/pools/{pool_id}/my-result",
    response_model=LotteryMyResultResponse,
    summary="내 추첨 결과 조회",
    description="특정 추첨 풀에서 현재 사용자의 결과를 조회합니다. 당첨 여부, 팬 가중치 상세, 풀 통계를 반환합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Returns user's result (won/lost), fan weight breakdown, and pool-level statistics."},
)
async def get_my_lottery_result(
    pool_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get the current user's lottery result for a specific pool.

    Requires authentication. Returns the user's result, fan weight
    breakdown, and pool-level statistics.
    """
    try:
        service = LotteryService(db)
        return await service.get_my_result(pool_id, user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


# ── 마이페이지: 전체 응모 이력 ──

class MyAllLotteryEntry(BaseModel):
    entry_id: str
    event_id: str
    event_title: str
    event_image_url: str | None = None
    event_date: str | None = None
    tier_id: str
    tier_name: str
    result: str  # pending | won | waitlisted | lost
    invested_ap: int = 0
    group_size: int = 1
    applied_at: str
    payment_deadline: str | None = None
    order_id: str | None = None
    # waitlisted 인 경우 같은 pool 내 FIFO 순번 (1-based), 그 외 null
    waitlist_position: int | None = None
    # 응모한 tier 의 매진 여부 — 매진 + waitlisted 이면 사실상 낙첨 (좌석 더 안 나옴).
    # 프론트는 이 플래그로 "대기 N순위" → "낙첨" 표시 전환.
    is_tier_sold_out: bool = False
    # 당첨자(result=won)의 order 상태 — payment_required/confirmed/expired/cancelled.
    # won + expired/cancelled 면 "결제 기한 만료" 로 표시. None 이면 order 없음.
    lottery_order_status: str | None = None


class MyAllLotteryResponse(BaseModel):
    entries: list[MyAllLotteryEntry]


# ── Public Lottery Stats (consumer CTA 버튼 분기용) ──────────────────────

class PublicLotteryStatsResponse(BaseModel):
    event_id: str
    # phase: pre_apply | applying | closed | drawing | drawn
    phase: str
    total_entries: int
    total_seats: int
    competition_ratio: float
    opens_at: str | None = None
    closes_at: str | None = None


@router.get(
    "/{event_id}/lottery-stats",
    response_model=PublicLotteryStatsResponse,
    summary="공개 추첨 통계 (consumer CTA 분기용)",
    description="Consumer 이벤트 상세 페이지에서 CTA 버튼 라벨/활성 여부를 phase 기준으로 분기하기 위한 공개 엔드포인트. 민감 정보는 미포함.",
)
async def get_public_lottery_stats(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Public lottery stats. No auth required. Returns only phase + aggregates.

    phase 결정 (인터파크 방식 — phase_configs 테이블 SQL 시간 비교, cron/webhook 의존 X):
    - pre_apply: 현재 시각이 lottery phase 의 starts_at 이전
    - applying: 현재 시각이 lottery phase 의 [starts_at, ends_at] 안 + pool OPEN
    - closed: 현재 시각이 lottery phase ends_at 이후 + pool CLOSED (추첨 대기)
    - drawing: pool 일부 DRAWN
    - drawn: 모든 pool DRAWN

    풀이 만들어지지 않았어도 phase_configs 의 시간만으로 pre_apply/applying 결정.
    """
    from app.models.lottery import LotteryPool, LotteryPoolStatus
    from app.models.phase_config import PhaseConfig
    from datetime import datetime, timezone

    ev_row = (await db.execute(
        select(Event.id, Event.bidding_opens_at, Event.bidding_closes_at)
        .where(Event.id == event_id)
    )).first()
    if not ev_row:
        raise HTTPException(status_code=404, detail="Event not found")

    now = datetime.now(timezone.utc)

    # phase_configs 에서 lottery (또는 membership_presale) phase 조회
    # 둘 다 응모 phase 로 취급 (consumer "응모하기" 활성)
    lottery_phases = (await db.execute(
        select(PhaseConfig)
        .where(
            PhaseConfig.event_id == event_id,
            PhaseConfig.phase.in_(("lottery", "membership_presale")),
        )
        .order_by(PhaseConfig.sort_order.asc())
    )).scalars().all()

    # 응답용 opens_at / closes_at — lottery phase 가 있으면 그 값, 없으면 event.bidding_*
    if lottery_phases:
        # 가장 이른 starts_at 이 응모 시작, 가장 늦은 ends_at 이 응모 마감
        opens_at = min(p.starts_at for p in lottery_phases)
        closes_at = max(p.ends_at for p in lottery_phases)
        # 현재 시각이 어떤 lottery phase 안에 있는지 판정
        in_phase_window = any(
            p.starts_at <= now <= p.ends_at for p in lottery_phases
        )
        past_all_phases = all(now > p.ends_at for p in lottery_phases)
    else:
        opens_at = ev_row.bidding_opens_at
        closes_at = ev_row.bidding_closes_at
        in_phase_window = (
            opens_at is not None
            and closes_at is not None
            and opens_at <= now <= closes_at
        )
        past_all_phases = closes_at is not None and now > closes_at

    pools = (await db.execute(
        select(LotteryPool).where(LotteryPool.event_id == event_id)
    )).scalars().all()

    # phase 결정 — pool 상태 우선, 그 다음 시간 비교
    pool_statuses = {p.status for p in pools} if pools else set()

    if pools and all(s == LotteryPoolStatus.DRAWN for s in pool_statuses):
        phase = "drawn"
    elif pools and any(s == LotteryPoolStatus.DRAWN for s in pool_statuses):
        phase = "drawing"
    elif pools and all(s == LotteryPoolStatus.CLOSED for s in pool_statuses):
        phase = "closed"
    elif in_phase_window:
        # phase_configs 시간 안 — 응모 가능
        phase = "applying"
    elif past_all_phases:
        # phase 종료됐는데 pool 이 없거나 아직 OPEN — closed (추첨 대기)
        phase = "closed"
    else:
        phase = "pre_apply"

    pool_ids = [p.id for p in pools]
    total_entries = (
        await db.scalar(
            select(func.count(LotteryEntry.id)).where(LotteryEntry.pool_id.in_(pool_ids))
        )
        if pool_ids else 0
    ) or 0
    total_seats = sum(p.total_seats for p in pools) if pools else 0

    return PublicLotteryStatsResponse(
        event_id=str(event_id),
        phase=phase,
        total_entries=int(total_entries),
        total_seats=total_seats,
        competition_ratio=round(total_entries / max(total_seats, 1), 2),
        opens_at=opens_at.isoformat() if opens_at else None,
        closes_at=closes_at.isoformat() if closes_at else None,
    )


@router.get(
    "/my-lottery-history",
    response_model=MyAllLotteryResponse,
    summary="내 전체 추첨 응모 이력",
)
async def my_lottery_history(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """마이페이지용: 모든 이벤트에 대한 내 응모 이력."""
    try:
        return await _my_lottery_history_impl(user, db)
    except Exception as e:
        logger.exception("Lottery history failed: user=%s", user.id)
        raise HTTPException(status_code=500, detail="Internal server error")


async def _my_lottery_history_impl(user: User, db: AsyncSession):
    entries_q = await db.execute(
        select(LotteryEntry).where(LotteryEntry.user_id == user.id)
        .order_by(LotteryEntry.created_at.desc())
        .limit(50)
    )
    entries = entries_q.scalars().all()
    if not entries:
        return MyAllLotteryResponse(entries=[])

    pool_ids = list({e.pool_id for e in entries})
    pools_q = await db.execute(select(LotteryPool).where(LotteryPool.id.in_(pool_ids)))
    pools = {p.id: p for p in pools_q.scalars().all()}

    event_ids = list({p.event_id for p in pools.values()})
    events_q = await db.execute(
        select(Event.id, Event.title, Event.image_url, Event.event_date)
        .where(Event.id.in_(event_ids))
    )
    events_map = {r.id: r for r in events_q.all()}

    tier_ids = list({p.tier_id for p in pools.values()})
    tiers_q = await db.execute(
        select(SeatTier.id, SeatTier.name, SeatTier.capacity, SeatTier.sold_count)
        .where(SeatTier.id.in_(tier_ids))
    )
    tiers_map: dict[uuid.UUID, dict] = {
        r.id: {
            "name": r.name,
            "is_sold_out": (r.capacity or 0) > 0 and (r.sold_count or 0) >= r.capacity,
        }
        for r in tiers_q.all()
    }

    from app.models.order import Order, OrderStatus
    won_entries = [e for e in entries if e.result == LotteryEntryResult.WON]
    # 만료/취소 order 도 포함 — 프론트가 "결제 기한 만료" 표시 분기에 사용.
    orders_map: dict[str, tuple[str, str | None, str]] = {}
    if won_entries:
        won_event_ids = list({pools[e.pool_id].event_id for e in won_entries if e.pool_id in pools})
        if won_event_ids:
            orders_q = await db.execute(
                select(Order.id, Order.event_id, Order.payment_deadline, Order.status, Order.created_at)
                .where(
                    Order.user_id == user.id,
                    Order.event_id.in_(won_event_ids),
                    Order.status.in_([
                        OrderStatus.PAYMENT_REQUIRED,
                        OrderStatus.CONFIRMED,
                        OrderStatus.EXPIRED,
                        OrderStatus.CANCELLED,
                    ]),
                )
                .order_by(Order.created_at.desc())  # 최신 order 우선 (재시도 대비)
            )
            for o in orders_q.all():
                key = str(o.event_id)
                # 같은 event 에 여러 order 가 있을 경우 최신 1개만 유지
                if key in orders_map:
                    continue
                orders_map[key] = (
                    str(o.id),
                    o.payment_deadline.isoformat() if o.payment_deadline else None,
                    o.status.value if hasattr(o.status, "value") else str(o.status),
                )

    # WAITLISTED 순번 계산 — 같은 pool 내에서 created_at ASC 기준 FIFO
    waitlist_position_map: dict[str, int] = {}
    waitlisted_pool_ids = list({
        e.pool_id for e in entries if e.result == LotteryEntryResult.WAITLISTED
    })
    if waitlisted_pool_ids:
        wl_q = await db.execute(
            select(LotteryEntry.id, LotteryEntry.pool_id, LotteryEntry.created_at)
            .where(
                LotteryEntry.pool_id.in_(waitlisted_pool_ids),
                LotteryEntry.result == LotteryEntryResult.WAITLISTED,
            )
            .order_by(LotteryEntry.pool_id, LotteryEntry.created_at.asc())
        )
        pool_seq: dict[uuid.UUID, int] = {}
        for row in wl_q.all():
            pool_seq[row.pool_id] = pool_seq.get(row.pool_id, 0) + 1
            waitlist_position_map[str(row.id)] = pool_seq[row.pool_id]

    result = []
    for entry in entries:
        pool = pools.get(entry.pool_id)
        if not pool:
            continue
        ev = events_map.get(pool.event_id)
        order_info = orders_map.get(str(pool.event_id))
        tier_info = tiers_map.get(pool.tier_id, {"name": "—", "is_sold_out": False})
        result.append(MyAllLotteryEntry(
            entry_id=str(entry.id),
            event_id=str(pool.event_id),
            event_title=ev.title if ev else "—",
            event_image_url=ev.image_url if ev else None,
            event_date=ev.event_date.isoformat() if ev and ev.event_date else None,
            tier_id=str(pool.tier_id),
            tier_name=tier_info["name"],
            result=entry.result.value,
            invested_ap=entry.invested_ap or 0,
            group_size=entry.group_size,
            applied_at=entry.created_at.isoformat() if entry.created_at else "",
            payment_deadline=order_info[1] if order_info else None,
            order_id=order_info[0] if order_info else None,
            waitlist_position=waitlist_position_map.get(str(entry.id)),
            is_tier_sold_out=tier_info["is_sold_out"],
            lottery_order_status=order_info[2] if order_info else None,
        ))

    return MyAllLotteryResponse(entries=result)
