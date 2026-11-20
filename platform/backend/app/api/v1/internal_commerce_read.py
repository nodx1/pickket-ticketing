"""go write-through read-cluster (READ-AGGREGATE §7~14 + 정정6) — 집계 read.

빅뱅 read flip(D)용. go 는 커머스 테이블을 JOIN 못 하므로 v2 가 서버사이드 집계.
매출 정의(정정1 rev2, CEO 확정)를 **전 엔드포인트 단일 적용**:
  revenue_gross = SUM(total_amount) WHERE status IN _REVENUE_STATUSES(confirmed/paid/
    partially_refunded/refunded)
  refund_amount = SUM(total_refunded) WHERE 동일
  net_revenue   = revenue_gross − refund_amount   ← go 헤드라인 "매출"
판매수량(soldCount)은 refunded 제외(confirmed/paid/partially_refunded).

제외(사유): §10 funnel(seat_funnel_events 테이블 미존재 — 별도 신설), check-in 로그
export(check_in_logs=go-local 워크플로). checked_in_count 는 ticket.checked_in_at(v2 SoT)로 집계.
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import Text, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError, OrganizerRef, _err, _ok, _READ_CACHE_CONTROL,
    _require_event, _resolve_organizer, _batch_tier_sold, _internal_auth,
    _go_account_id_of,
    _event_order_aggregates,
)
from app.core.commerce_status import (
    REVENUE_STATUSES as _REVENUE_STATUSES,
    SOLD_SEAT_STATUSES as _SOLD_SEAT_STATUSES,
    SOLD_QTY_STATUSES as _SOLD_QTY_STATUSES,
    ORDER_STATUS_V2_TO_GO as _ORDER_STATUS_V2_TO_GO,
    GO_ATTENDEE_STATUSES as _GO_ATTENDEE_STATUSES,
    project_event_status as _project_event_status,
    project_order_status as _go_order_status,
    attendee_go_to_v2_list as _attendee_go_to_v2_list,
    event_go_to_v2_list,
    order_go_to_v2_list,
)
from app.core.database import get_db
from app.core.pii import normalize_phone_for_lookup, phone_lookup_digests
from app.models.discount_code import DiscountCode
from app.models.fee_schedule import FeeSchedule
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.order_item import OrderItem
from app.models.seat import Seat, SeatStatus
from app.models.settlement import OrganizerSettlement
from app.models.payment_attempt import PaymentAttempt
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User

router = APIRouter(dependencies=[Depends(_internal_auth)])


# ── 공통 집계 ────────────────────────────────────────────────────────────


async def _revenue_block(db: AsyncSession, *where) -> dict:
    """canonical 매출 블록(정정1 rev2): gross/refund/net/order_count."""
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(Order.total_amount).filter(Order.status.in_(_REVENUE_STATUSES)), 0),
                func.coalesce(func.sum(Order.total_refunded).filter(Order.status.in_(_REVENUE_STATUSES)), 0),
                func.count(Order.id).filter(Order.status.in_(_REVENUE_STATUSES)),
            ).where(*where)
        )
    ).first()
    gross = float(row[0] or 0)
    refund = float(row[1] or 0)
    return {
        "revenue_gross": round(gross, 2),
        "refund_amount": round(refund, 2),
        "net_revenue": round(gross - refund, 2),  # go 헤드라인 "매출"
        "order_count": int(row[2] or 0),
    }


async def _attendee_count(db: AsyncSession, event_id: uuid.UUID) -> int:
    return int((await db.execute(
        select(func.count(Ticket.id)).where(
            Ticket.event_id == event_id, Ticket.status != TicketStatus.CANCELLED
        )
    )).scalar() or 0)


async def _checked_in_count(db: AsyncSession, event_id: uuid.UUID) -> int:
    """체크인수 = ticket.checked_in_at NOT NULL(v2 SoT). go check_in_logs 상세는 go-local."""
    return int((await db.execute(
        select(func.count(Ticket.id)).where(
            Ticket.event_id == event_id, Ticket.checked_in_at.isnot(None)
        )
    )).scalar() or 0)


async def _daily_sales(db: AsyncSession, event_id: uuid.UUID) -> list[dict]:
    """일별 매출(net 대상 status). Python 그룹핑(이식성·이벤트 범위 한정)."""
    rows = (await db.execute(
        select(Order.created_at, Order.total_amount, Order.total_refunded)
        .where(Order.event_id == event_id, Order.status.in_(_REVENUE_STATUSES))
    )).all()
    agg: dict[str, dict] = {}
    for created, total, refunded in rows:
        day = (created or datetime.now(timezone.utc)).date().isoformat()
        a = agg.setdefault(day, {"date": day, "amount": 0.0, "count": 0})
        a["amount"] += float(total or 0) - float(refunded or 0)
        a["count"] += 1
    return [agg[d] for d in sorted(agg)]


async def _product_sales(db: AsyncSession, event_id: uuid.UUID) -> list[dict]:
    """티어(=go product)별 판매량/매출. order_items JOIN orders(soldQty status)."""
    rows = (await db.execute(
        select(
            SeatTier.id, SeatTier.name,
            func.coalesce(func.sum(OrderItem.quantity), 0),
            func.coalesce(func.sum(OrderItem.line_amount), 0),
        )
        .select_from(SeatTier)
        .outerjoin(OrderItem, OrderItem.tier_id == SeatTier.id)
        .outerjoin(
            Order,
            (Order.id == OrderItem.order_id) & (Order.status.in_(_SOLD_QTY_STATUSES)),
        )
        .where(SeatTier.event_id == event_id)
        .group_by(SeatTier.id, SeatTier.name)
    )).all()
    return [
        {"tier_id": str(tid), "name": name, "sold": int(qty or 0), "revenue": round(float(rev or 0), 2)}
        for tid, name, qty, rev in rows
    ]


# ── §7 이벤트 대시보드 ───────────────────────────────────────────────────


@router.get("/events/{event_id}/dashboard", summary="go read: 이벤트 대시보드")
async def event_dashboard(event_id: uuid.UUID, request: Request, response: Response,
                          db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rev = await _revenue_block(db, Order.event_id == event_id)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "summary": {
            "total_orders": rev["order_count"],
            "total_attendees": await _attendee_count(db, event_id),
            "total_revenue": rev["net_revenue"],  # = net(go 헤드라인)
            "net_revenue": rev["net_revenue"],
            "revenue_gross": rev["revenue_gross"],
            "refund_amount": rev["refund_amount"],
            "checked_in_count": await _checked_in_count(db, event_id),
        },
        "daily_sales": await _daily_sales(db, event_id),
        "product_sales": await _product_sales(db, event_id),
    })


# ── §8 조직 대시보드 ─────────────────────────────────────────────────────


async def _org_window_revenue(db: AsyncSession, organizer_id: uuid.UUID,
                              start: datetime, end: datetime) -> dict:
    where = [
        Event.organizer_id == organizer_id,
        Order.created_at >= start, Order.created_at < end,
    ]
    row = (await db.execute(
        select(
            func.coalesce(func.sum(Order.total_amount).filter(Order.status.in_(_SOLD_QTY_STATUSES)), 0),
            func.count(Order.id).filter(Order.status.in_(_SOLD_QTY_STATUSES)),
        ).select_from(Order).join(Event, Event.id == Order.event_id).where(*where)
    )).first()
    return {"revenue": round(float(row[0] or 0), 2), "orders": int(row[1] or 0)}


@router.get("/organizers/{organizer_ref}/dashboard", summary="go read: 조직 대시보드")
async def organizer_dashboard(organizer_ref: str, request: Request, response: Response,
                              db: AsyncSession = Depends(get_db)):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week = now - timedelta(days=7)
    prev_week = now - timedelta(days=14)
    today_b = await _org_window_revenue(db, organizer_id, today, now + timedelta(days=1))
    this_week = await _org_window_revenue(db, organizer_id, week, now)
    last_week = await _org_window_revenue(db, organizer_id, prev_week, week)
    # active check-ins(오늘) = ticket.checked_in_at >= today, organizer 이벤트
    active_ci = int((await db.execute(
        select(func.count(Ticket.id)).select_from(Ticket)
        .join(Event, Event.id == Ticket.event_id)
        .where(Event.organizer_id == organizer_id, Ticket.checked_in_at >= today)
    )).scalar() or 0)
    # low_stock = 판매중(live) 이벤트의 잔여 1~5 티어
    low_stock = int((await db.execute(
        select(func.count(SeatTier.id)).select_from(SeatTier)
        .join(Event, Event.id == SeatTier.event_id)
        .where(
            Event.organizer_id == organizer_id,
            (SeatTier.capacity - SeatTier.sold_count) >= 1,
            (SeatTier.capacity - SeatTier.sold_count) <= 5,
        )
    )).scalar() or 0)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "today_revenue": today_b["revenue"], "today_orders": today_b["orders"],
        "this_week_revenue": this_week["revenue"], "this_week_orders": this_week["orders"],
        "last_week_revenue": last_week["revenue"], "last_week_orders": last_week["orders"],
        "active_check_ins": active_ci,
        "low_stock_count": low_stock,
    })


@router.get("/organizers/{organizer_ref}/fee-plan", summary="go read: organizer 유효 fee plan(수수료 정본)")
async def organizer_fee_plan(
    organizer_ref: str, response: Response, db: AsyncSession = Depends(get_db)
):
    """레벨2 컷오버 T3 — go `platform_fee_plans` 대체 read.

    go 는 `platform_fee_plans INNER JOIN accounts` 로 수수료율을 읽었다. accounts 가
    비워지면서 이 조회가 항상 NULL → **플랫폼 수수료 0원**으로 주문이 생성되던 경로다.
    수수료 정본을 v2 `fee_schedules` 로 옮기고 여기서 유효 스케줄을 내려준다.

    해석 순서: organizer scope(활성) → 없으면 플랫폼 기본(organizer/event 모두 NULL).
    ⚠️ 값 계약은 **go 기존 계약을 그대로 유지**한다 — `fee_percentage` 는 백분율(3.00 = 3%).
       v2 `platform_fee_rate` 는 비율(0.0300)이라 ×100 해서 내려준다.
    ℹ️ v2 `fee_schedules` 에는 min/max fee 개념이 없다. go 유일 플랜이 min=0·max=NULL 이라
       이관 손실이 없으며, 상한/하한이 필요해지면 컬럼 신설이 선행돼야 한다.
    """
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)

    async def _active(*conds):
        return (
            await db.execute(
                select(FeeSchedule)
                .where(FeeSchedule.effective_until.is_(None), *conds)
                .order_by(FeeSchedule.effective_from.desc())
                .limit(1)
            )
        ).scalars().first()

    row = await _active(
        FeeSchedule.organizer_id == organizer_id, FeeSchedule.event_id.is_(None)
    )
    scope = "organizer"
    if row is None:
        row = await _active(
            FeeSchedule.organizer_id.is_(None), FeeSchedule.event_id.is_(None)
        )
        scope = "platform"
    if row is None:
        # 유효 스케줄이 없으면 **0원으로 흘리지 않는다** — 호출측이 fail-closed 하도록 명시 응답.
        #
        # 계약(T17에서 명문화): `fee_plan: null` 은 "수수료 0" 이 **아니라** "산정 불가" 다.
        # 위에서 organizer → platform 스코프 폴백까지 마쳤으므로, 여기 도달했다는 것은
        # **플랫폼 기본 스케줄조차 없다**는 설정 사고를 뜻한다. 호출측은 이 값을 0 으로
        # 강등하지 말고 결제를 막아야 한다(organizer checkout/initiate 가 503 으로 차단).
        # 예전엔 이 주석이 "fail-closed 하라"고만 적혀 있고 호출측은 정확히 0 으로 흘려
        # 설계와 구현이 모순이었다.
        return _ok({"fee_plan": None})

    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "fee_plan": {
            "id": str(row.id),
            "scope": scope,
            "fee_type": row.fee_type,
            "fee_percentage": float(row.platform_fee_rate or 0) * 100,
            "fee_fixed": float(row.platform_fee_fixed or 0),
            "min_fee": 0,
            "max_fee": None,
        }
    })


def _parse_org_ref(ref: str) -> OrganizerRef:
    try:
        return OrganizerRef(organizer_id=uuid.UUID(ref))
    except ValueError:
        return OrganizerRef(go_account_id=ref)


# ── §9 리포트 ────────────────────────────────────────────────────────────


@router.get("/events/{event_id}/reports", summary="go read: 리포트(sales/products/attendees/promo)")
async def event_reports(event_id: uuid.UUID, request: Request, response: Response,
                        type: str = "sales", db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    if type == "sales":
        rev = await _revenue_block(db, Order.event_id == event_id)
        aov = rev["net_revenue"] / rev["order_count"] if rev["order_count"] else 0.0
        return _ok({
            "type": "sales",
            "daily_sales": await _daily_sales(db, event_id),
            "total_revenue": rev["net_revenue"], "revenue_gross": rev["revenue_gross"],
            "total_orders": rev["order_count"], "avg_order_value": round(aov, 2),
            "refunded_amount": rev["refund_amount"],
        })
    if type == "products":
        items = await _product_sales(db, event_id)
        stock = {str(t.id): int((t.capacity or 0) - (t.sold_count or 0)) for t in (
            await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        ).scalars().all()}
        for it in items:
            it["stock"] = stock.get(it["tier_id"], 0)
        return _ok({
            "type": "products", "items": items,
            "summary": {
                "total_sold": sum(i["sold"] for i in items),
                "total_revenue": round(sum(i["revenue"] for i in items), 2),
                "total_stock": sum(i["stock"] for i in items),
            },
        })
    if type == "attendees":
        total = await _attendee_count(db, event_id)
        checked = await _checked_in_count(db, event_id)
        # 일별 등록(ticket.created_at)
        rows = (await db.execute(
            select(Ticket.created_at).where(
                Ticket.event_id == event_id, Ticket.status != TicketStatus.CANCELLED
            )
        )).all()
        daily: dict[str, int] = {}
        for (created,) in rows:
            d = (created or datetime.now(timezone.utc)).date().isoformat()
            daily[d] = daily.get(d, 0) + 1
        return _ok({
            "type": "attendees",
            "daily_registrations": [{"date": d, "count": daily[d]} for d in sorted(daily)],
            "total_attendees": total, "checked_in_count": checked,
            "check_in_rate": round(checked / total * 100, 2) if total else 0.0,
        })
    if type == "promo":
        rows = (await db.execute(
            select(
                DiscountCode.code, DiscountCode.discount_type, DiscountCode.used_count,
                DiscountCode.rate, DiscountCode.amount,
            ).where(DiscountCode.event_id == event_id)
        )).all()
        # discount_total: 고정할인은 amount×used_count 로 정확. 정률은 주문별 gross 의존이라
        # 정확 집계 불가(OrderDiscount 미저장) → 정률은 null(go-side 또는 후속 영속화).
        items = []
        for c, dt, uc, rate, amount in rows:
            dtv = dt.value if hasattr(dt, "value") else dt
            if dtv == "fixed" and amount is not None:
                disc_total = round(float(amount) * int(uc or 0), 2)
            else:
                disc_total = None  # 정률 누계는 OrderDiscount 영속화 후속(현재 미산정)
            items.append({"code": c, "promo_type": dtv, "usage_count": int(uc or 0),
                          "discount_total": disc_total})
        return _ok({"type": "promo", "items": items})
    return _err(ApiError("VALIDATION_ERROR", f"invalid report type: {type}", 400, "type"))


# ── §10 좌석 분석 (funnel 제외 — seat_funnel_events 미존재) ───────────────


@router.get("/events/{event_id}/seat-analytics", summary="go read: 좌석 분석")
async def seat_analytics(event_id: uuid.UUID, request: Request, response: Response,
                         db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    status_rows = (await db.execute(
        select(Seat.status, func.count()).where(Seat.event_id == event_id).group_by(Seat.status)
    )).all()
    status_counts = {(s.value if hasattr(s, "value") else str(s)): int(c) for s, c in status_rows}
    tiers = (await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))).scalars().all()
    sold_map = await _batch_tier_sold(db, tiers)  # H2: tier별 N+1 제거
    tier_stats = []
    for t in tiers:
        sold = int(sold_map.get(t.id, 0))
        cap = int(t.capacity or 0)
        tier_stats.append({
            "tier_id": str(t.id), "name": t.name, "capacity": cap, "sold": sold,
            "base_price": float(t.base_price or 0),  # 🟠6
            "fill_rate": round(sold / cap * 100, 2) if cap else 0.0,
        })
    # section_top_revenue: 섹션별 SOLD 좌석 × tier base_price
    sec_rows = (await db.execute(
        select(Seat.section, func.count(), func.coalesce(func.sum(SeatTier.base_price), 0))
        .select_from(Seat).join(SeatTier, SeatTier.id == Seat.tier_id)
        .where(Seat.event_id == event_id, Seat.status.in_(_SOLD_SEAT_STATUSES))
        .group_by(Seat.section)
    )).all()
    section_top = sorted(
        [{"section": s, "sold": int(c), "revenue": round(float(r or 0), 2)} for s, c, r in sec_rows],
        key=lambda x: x["revenue"], reverse=True,
    )
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "status_counts": status_counts, "tier_stats": tier_stats,
        "section_top_revenue": section_top,
        "funnel": None,  # seat_funnel_events 테이블 신설 후 제공(별도 트랙)
    })


# ── §11 매출 인텔리전스 (경로 정정: revenue-intelligence) ─────────────────


@router.get("/events/{event_id}/analytics/revenue-intelligence", summary="go read: 매출 인텔리전스")
async def revenue_intelligence(event_id: uuid.UUID, request: Request, response: Response,
                               db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rev = await _revenue_block(db, Order.event_id == event_id)
    unique_buyers = int((await db.execute(
        select(func.count(func.distinct(Order.user_id)))
        .where(Order.event_id == event_id, Order.status.in_(_REVENUE_STATUSES))
    )).scalar() or 0)
    aov = rev["net_revenue"] / rev["order_count"] if rev["order_count"] else 0.0
    refund_rate = rev["refund_amount"] / rev["revenue_gross"] * 100 if rev["revenue_gross"] else 0.0
    by_product = await _product_sales(db, event_id)
    promo_rows = (await db.execute(
        select(DiscountCode.code, DiscountCode.used_count).where(DiscountCode.event_id == event_id)
    )).all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "kpis": {
            "total_revenue": rev["net_revenue"], "revenue_gross": rev["revenue_gross"],
            "total_orders": rev["order_count"], "avg_order_value": round(aov, 2),
            "unique_buyers": unique_buyers, "refund_rate": round(refund_rate, 2),
            "refund_amount": rev["refund_amount"],
        },
        "by_product": by_product,
        "promo_codes": [{"code": c, "usage": int(u or 0)} for c, u in promo_rows],
    })


# ── §12 정산 목록 ────────────────────────────────────────────────────────


@router.get("/organizers/{organizer_ref}/settlements", summary="go read: 정산 목록")
async def organizer_settlements(organizer_ref: str, request: Request, response: Response,
                                db: AsyncSession = Depends(get_db), limit: int = 50, offset: int = 0):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    total = int((await db.execute(
        select(func.count()).select_from(OrganizerSettlement)
        .where(OrganizerSettlement.organizer_id == organizer_id)
    )).scalar() or 0)
    # 은행 정보(organizer User) — 정산 입금정보(🔴2).
    org = (await db.execute(select(User).where(User.id == organizer_id))).scalar_one_or_none()
    bank = {
        "bank_name": getattr(org, "settlement_bank", None) if org else None,
        "account_number": getattr(org, "settlement_account_number", None) if org else None,
        "account_holder": getattr(org, "settlement_account_holder", None) if org else None,
    }
    rows = (await db.execute(
        select(OrganizerSettlement).where(OrganizerSettlement.organizer_id == organizer_id)
        .order_by(OrganizerSettlement.period_start.desc()).limit(limit).offset(offset)
    )).scalars().all()
    items = []
    for s in rows:
        gross = float(s.gross_revenue or 0)
        plat = float(s.platform_fee or 0)
        # 기간 내 주문수(매출대상) — settlement 은 organizer-period 집계라 event_title 없음(N/A).
        order_count = int((await db.execute(
            select(func.count(Order.id)).select_from(Order).join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == organizer_id,
                Order.status.in_(_REVENUE_STATUSES),
                Order.created_at >= s.period_start, Order.created_at < s.period_end,
            )
        )).scalar() or 0)
        items.append({
            "settlement_id": str(s.id),
            "event_title": None,  # v2 settlement=organizer·period 집계(이벤트별 아님)
            "period_start": s.period_start.isoformat() if s.period_start else None,
            "period_end": s.period_end.isoformat() if s.period_end else None,
            "gross_amount": gross, "platform_fee": plat,
            "platform_fee_rate": round(plat / gross, 4) if gross > 0 else 0.0,
            "pg_fee": float(s.pg_fee or 0), "refund_amount": float(s.total_refunds or 0),
            "net_amount": float(s.net_payout or 0), "order_count": order_count,
            "status": s.status,
            "paid_at": s.paid_at.isoformat() if s.paid_at else None,
            "memo": s.dispute_reason,
            **bank,
        })
    # 현월 요약
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    msum = (await db.execute(
        select(
            func.coalesce(func.sum(OrganizerSettlement.gross_revenue), 0),
            func.coalesce(func.sum(OrganizerSettlement.platform_fee), 0),
            func.coalesce(func.sum(OrganizerSettlement.net_payout), 0),
        ).where(
            OrganizerSettlement.organizer_id == organizer_id,
            OrganizerSettlement.period_start >= month_start,
        )
    )).first()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "settlements": items, "total": total, "limit": limit, "offset": offset,
        "month_summary": {
            "gross_amount": float(msum[0] or 0), "platform_fee": float(msum[1] or 0),
            "net_amount": float(msum[2] or 0),
        },
    })


# ── §13 통합 검색 ────────────────────────────────────────────────────────


@router.get("/organizers/{organizer_ref}/search", summary="go read: 통합 검색")
async def organizer_search(organizer_ref: str, request: Request, response: Response,
                           q: str = "", db: AsyncSession = Depends(get_db), limit: int = 20):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    limit = max(1, min(limit, 100))
    like = f"%{q}%"
    events = (await db.execute(
        select(Event.id, Event.title, Event.slug, Event.status, Event.sales_paused).where(
            Event.organizer_id == organizer_id, Event.title.ilike(like)
        ).limit(limit)
    )).all()
    orders = (await db.execute(
        select(Order.id, Order.external_ref, Order.event_id, Order.buyer_name, Order.buyer_email,
               Order.status, Order.created_at)
        .select_from(Order).join(Event, Event.id == Order.event_id)
        .where(Event.organizer_id == organizer_id,
               or_(Order.buyer_name.ilike(like), Order.buyer_email.ilike(like),
                   Order.external_ref.ilike(like)))
        .limit(limit)
    )).all()
    # 🟠4 참석자(ticket) 검색 — buyer/owner name·email
    attendees = (await db.execute(
        select(Ticket.id, Ticket.event_id, Order.buyer_name, Order.buyer_email, User.name, User.email)
        .select_from(Ticket).join(Event, Event.id == Ticket.event_id)
        .outerjoin(Order, Order.id == Ticket.purchase_order_id)
        .outerjoin(User, User.id == Ticket.current_owner_id)
        .where(Event.organizer_id == organizer_id,
               or_(Order.buyer_name.ilike(like), Order.buyer_email.ilike(like),
                   User.name.ilike(like), User.email.ilike(like)))
        .limit(limit)
    )).all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "events": [{"event_id": str(i), "title": t, "slug": sl, "status": _project_event_status(s, sp)}
                   for i, t, sl, s, sp in events],
        # external_order_id = go order id. go 의 주문 상세·환불 라우트가 **이 값**으로 조회한다
        # (v2 order_id 를 내려주면 화면 링크가 404 가 된다 — 2026-07-27 prod 실결함).
        "orders": [{"order_id": str(i), "external_order_id": ext, "order_number": ext or str(i),
                    "event_id": str(eid),
                    "buyer_name": n, "buyer_email": e, "status": _go_order_status(st),
                    "ordered_at": ca.isoformat() if ca else None}
                   for i, ext, eid, n, e, st, ca in orders],
        "attendees": [{"ticket_id": str(tid), "event_id": str(eid),
                       "name": (bn or un), "email": (be or ue)}
                      for tid, eid, bn, be, un, ue in attendees],
    })


# ── §14 주문/참석자 목록 + export ────────────────────────────────────────


# 🔴 초대권 판별자 — go 가 발권 때 티켓에 심는다(`lib/server/invitations.ts:539`).
#
#    **결제수단으로 판정하지 않는다.** 왜 안 되는지 실측으로 둘 다 막혀 있다:
#      · `offline` 은 주최자 **수동 주문**의 정당한 값이다(현장결제). 이걸 「초대권」으로
#        읽으면 수동 주문이 초대권으로 둔갑해 정산 오해로 간다.
#      · `free` 는 **무료 티켓**에도 쓰인다. KLPGA 에 무료 티어가 없어 지금은 우연히
#        갈리지만, 무료 행사를 여는 순간 일반 손님 주문이 초대권으로 뜬다.
#
#    ⚠️ v2 `orders` 에는 answers 컬럼이 없다(실측: payment_metadata·source 뿐).
#       판별자는 그 주문의 **티켓**에 있다.
_INVITATION_ANSWER_KEY = "_invitationId"

# 🔴 수동발권 판별자 — go 발권 라우트가 심는다(`ticket-issuance/route.ts:113-117`).
#
#    같은 라우트가 `paymentMethod: "offline"` 도 적어서(:106) 화면이 **「현장결제」**로
#    떴다 — 돈을 받은 적이 없는 0원 발권인데. 초대권 판정은 정확히 동작했고(표식 없음
#    → false) 결제수단 라벨로 되돌아간 것이라, **갈래가 하나 모자랐을 뿐**이다.
#
#    ⚠️ `orders.memo` 로 판정하지 않는다. 주최자가 편집할 수 있는 **자유 텍스트**라
#       아무 주문에나 같은 문구를 넣을 수 있다(T2-ORD 주문 워크플로 메모).
_MANUAL_ISSUE_ANSWER_KEY = "_manualIssue"


def _order_has_ticket_answer_sql(key: str):
    """목록용 — 그 주문의 티켓에 `key` 가 있는가. 상관 EXISTS.

    🔴 판별자마다 따로 짜지 않고 여기 하나로 모은다. 아래 `.as_string()` 함정을
    **두 곳에 복사하면 언젠가 한쪽만 고친다.**

    🔴 `.as_string()` 을 반드시 거친다. 없으면 **SQLite 에서 공허하게 참**이 된다:

        answers[key].isnot(None)     sqlite → JSON_QUOTE(JSON_EXTRACT(…)) IS NOT NULL
                                              ⟹ 🔴 어떤 행이든 항상 참(NULL 이어도 'null')
        answers[key].as_string()     sqlite → JSON_EXTRACT(…) IS NOT NULL          ✅
                                     pg     → CAST(answers ->> key AS VARCHAR) …   ✅

    실측(2026-08-04): 앞 형태로 짜고 실 PG 에서 4/4 PASS 를 받았는데, 같은 코드가 SQLite
    에서는 **카드 주문까지 초대권**으로 나왔다. 한쪽만 돌렸으면 못 봤다.

    ⚠️ 목록은 주문 수만큼 티켓을 따로 조회하지 않는다(N+1 금지). 판별자가 둘이어도
       EXISTS 두 개가 **같은 한 번의 질의**에 실린다.
    """
    return (
        select(Ticket.id)
        .where(
            Ticket.purchase_order_id == Order.id,
            Ticket.answers[key].as_string().isnot(None),
        )
        .exists()
    )


def _tickets_have_answer(tickets, key: str) -> bool:
    """상세용 — 이미 읽어온 티켓으로 판정한다(추가 질의 0).

    🔴 위 SQL 판정의 **파이썬 쌍둥이**다. 둘이 갈라지면 목록과 상세가 서로 다른 말을
    한다 — 같은 키를 넘겨 쓰고, 같은 픽스처로 둘을 대조한다.
    """
    return any((t.answers or {}).get(key) for t in tickets)


# 🔴 결제 시도 분류 — **원문을 그대로 내보내지 않는다**.
#
#    `payment_attempts.error_message` 는 내부 문구다("reconciliation: PG status failed").
#    주최자 화면에 그대로 뜨면 아무도 못 읽고, 우리 내부 사정이 밖으로 샌다.
#    ⟹ 분류(기계용)와 원문(진단용)을 **나눠** 싣고, 화면은 분류만 쓴다.
_ATTEMPT_ERROR_PATTERNS: tuple[tuple[str, str], ...] = (
    ("timeout", "timeout"),
    ("timed out", "timeout"),
    ("declin", "pg_declined"),
    ("reject", "pg_declined"),
    ("failed", "pg_declined"),
    ("invalid", "pg_declined"),
)


def _classify_attempt_error(message: str | None) -> str | None:
    """거부 사유 분류. 모르면 `unknown` — **원문을 분류로 쓰지 않는다**."""
    if not message:
        return None
    low = message.lower()
    for needle, kind in _ATTEMPT_ERROR_PATTERNS:
        if needle in low:
            return kind
    return "unknown"


async def _payment_attempt_summaries(
    db: AsyncSession, order_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict]:
    """주문별 결제 시도 요약 — 🔴 **한 번의 질의**로 전부 가져온다.

    ## 왜 필요한가 (2026-08-10)

    주최자 주문 목록에서 「결제창에서 그만둔 것」과 「나이스가 거절한 것」이 **같아 보인다**
    (둘 다 pending/expired). 오늘 민원 3건이 전부 이탈이었는데 확인에 반나절이 들었다.

        시도 0건   → 결제창 이탈 (나이스에 요청조차 안 감)
        failed     → 실제 실패
        succeeded  → 성공

    ## 🔴 N+1 금지

    주문 수만큼 질의하면 목록이 죽는다. `order_id IN (...)` 한 번으로 받고, 주문별
    **마지막 시도**를 파이썬에서 고른다(행 수가 주문당 한 자릿수라 정렬 비용이 없다).

    ⚠️ **마지막**이어야 한다. 첫 시도를 보면 "실패 후 성공" 이 「실패」로 뜬다.
    """
    if not order_ids:
        return {}
    rows = (
        await db.execute(
            select(
                PaymentAttempt.order_id,
                PaymentAttempt.status,
                PaymentAttempt.error_message,
                PaymentAttempt.created_at,
                PaymentAttempt.attempt_no,
            ).where(PaymentAttempt.order_id.in_(order_ids))
        )
    ).all()

    acc: dict[uuid.UUID, dict] = {}
    for oid, status, err, created, attempt_no in rows:
        cur = acc.setdefault(oid, {"attempt_count": 0, "_key": None,
                                   "last_status": None, "last_error": None, "last_at": None})
        cur["attempt_count"] += 1
        # 🔴 마지막 판정 — created_at 동률이면 attempt_no 로 가른다(같은 초에 두 번 가능).
        key = (created, int(attempt_no or 0))
        if cur["_key"] is None or key > cur["_key"]:
            cur["_key"] = key
            cur["last_status"] = status.value if hasattr(status, "value") else str(status)
            cur["last_error"] = err
            cur["last_at"] = created.isoformat() if created else None
    for cur in acc.values():
        cur.pop("_key", None)
        cur["last_error_kind"] = _classify_attempt_error(cur["last_error"])
    return acc


def _order_row(o: Order, *, is_invitation: bool, is_manual_issue: bool,
               attempts: dict | None) -> dict:
    """⚠️ 두 플래그 모두 **기본값을 두지 않는다** — 새 호출부가 말없이 False 로 새어
    초대권·수동발권이 「현장결제」로 되돌아가는 걸 막는다(호출부가 반드시 판정하게)."""
    return {
        "order_id": str(o.id), "external_ref": o.external_ref,
        "order_number": o.external_ref or str(o.id),  # go 주문번호(external) 표시용
        "buyer_name": o.buyer_name, "buyer_email": o.buyer_email,
        "total_amount": float(o.total_amount or 0),
        "paid_amount": float(o.total_amount or 0),  # 고객 실결제액(=청구 total)
        "total_refunded": float(o.total_refunded or 0),
        "status": _go_order_status(o.status),
        "payment_method": o.pg_provider,
        "is_invitation": is_invitation,
        "is_manual_issue": is_manual_issue,
        # 🔴 결제 시도 요약 — 「이탈」과 「실패」를 화면이 가를 유일한 근거.
        #    시도가 0건이면 `attempt_count: 0` 이 온다(키 자체는 항상 있다).
        "payment_attempts": {
            "attempt_count": (attempts or {}).get("attempt_count", 0),
            "last_status": (attempts or {}).get("last_status"),
            # 분류(기계용). 화면은 이것만 쓴다.
            "last_error_kind": (attempts or {}).get("last_error_kind"),
            # 원문(진단용) — 🔴 화면에 그대로 노출하지 않는다.
            "last_error": (attempts or {}).get("last_error"),
            "last_at": (attempts or {}).get("last_at"),
        },
        "ordered_at": o.created_at.isoformat() if o.created_at else None,
    }


@router.get("/events/{event_id}/orders", summary="go read: 주문 목록")
async def event_orders(event_id: uuid.UUID, request: Request, response: Response,
                       db: AsyncSession = Depends(get_db), status: str | None = None,
                       q: str | None = None, issue_source: str | None = None,
                       limit: int = 50, offset: int = 0):
    """주문 목록.

    ## 🔴 `issue_source` — 「몇 장 팔렸나」를 세기 위한 필터 (2026-08-11)

    배지로는 초대권·수동발권과 실판매가 갈렸지만 **세는 것이 안 됐다**. 대회 중에
    목록으로 판매량을 보면 초대권이 섞인다.

    ```
    없음      전체 (지금 그대로)
    "sale"    초대권·수동발권이 **아닌** 것만 = 실판매
    "issued"  초대권·수동발권 인 것만
    ```

    ⚠️ 모르는 값은 **400** 이다. 조용히 전체로 흘리면 "필터가 걸렸다" 고 믿은 채
       틀린 수를 읽는다 — 그게 이 기능이 막으려던 바로 그 사고다.
    """
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    filters = [Order.event_id == event_id]

    # 🔴 **같은 `filters` 에 붙인다.** 총계(`count`)와 목록(`select`)이 이 리스트를
    #    공유하므로 조건 하나만 더하면 총계가 저절로 맞는다.
    #    별도 쿼리를 만들면 페이지를 넘길 때 총계가 어긋난다 — 이 작업의 핵심이다.
    if issue_source is not None:
        if issue_source not in ("sale", "issued"):
            return _err(ApiError(
                "VALIDATION_ERROR",
                "issue_source 는 sale 또는 issued 여야 합니다",
                400, "issue_source",
            ))
        # 발행경로 = 초대권 **또는** 수동발권. 표시(`is_invitation`/`is_manual_issue`)와
        # 같은 표현식을 쓴다 — 판정이 두 벌이 되면 배지와 필터가 갈린다.
        issued_expr = or_(
            _order_has_ticket_answer_sql(_INVITATION_ANSWER_KEY),
            _order_has_ticket_answer_sql(_MANUAL_ISSUE_ANSWER_KEY),
        )
        filters.append(issued_expr if issue_source == "issued" else ~issued_expr)

    if status:  # go 6-상태 → v2 역투영
        v2s = [k for k, v in _ORDER_STATUS_V2_TO_GO.items() if v == status]
        if not v2s:
            response.headers["Cache-Control"] = _READ_CACHE_CONTROL
            return _ok({"orders": [], "total": 0, "limit": limit, "offset": offset})
        filters.append(Order.status.in_([OrderStatus(s) for s in v2s]))
    if q:  # 🟠3 주문 검색(order_number=external_ref / buyer)
        like = f"%{q}%"
        filters.append(or_(
            Order.external_ref.ilike(like), Order.buyer_name.ilike(like), Order.buyer_email.ilike(like),
        ))
    total = int((await db.execute(select(func.count()).select_from(Order).where(*filters))).scalar() or 0)
    rows = (await db.execute(
        select(
            Order,
            _order_has_ticket_answer_sql(_INVITATION_ANSWER_KEY).label("is_invitation"),
            _order_has_ticket_answer_sql(_MANUAL_ISSUE_ANSWER_KEY).label("is_manual_issue"),
        )
        .where(*filters).order_by(Order.created_at.desc()).limit(limit).offset(offset)
    )).all()
    # 🔴 목록 전체의 시도 요약을 **한 번에** 받는다(N+1 금지).
    attempts_by_order = await _payment_attempt_summaries(db, [o.id for o, _i, _m in rows])
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"orders": [_order_row(o, is_invitation=bool(inv), is_manual_issue=bool(man),
                                      attempts=attempts_by_order.get(o.id))
                           for o, inv, man in rows],
                "total": total, "limit": limit, "offset": offset,
                # 🔴 적용된 필터를 **되돌려 준다**. go 화면이 이 값으로 "필터가 먹었는가"를
                #    판정한다 — 없거나 다르면 「적용되지 않았습니다」를 띄운다.
                #    ⚠️ 이게 없으면 v2 롤백·파라미터명 변경 시 화면이 **조용히 전체**를
                #       보여주고 발주처가 그것을 「실판매 N건」으로 읽는다.
                "issue_source": issue_source})


@router.get("/events/{event_id}/attendees", summary="go read: 참석자(=ticket) 목록")
async def event_attendees(event_id: uuid.UUID, request: Request, response: Response,
                          db: AsyncSession = Depends(get_db), status: str | None = None,
                          q: str | None = None, limit: int = 100, offset: int = 0):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    # name/email/phone = order.buyer_* 우선, 없으면 owner User(등록회원) 폴백(🔴1).
    filters = [Ticket.event_id == event_id]
    if status:
        # 🔴 필터는 **표시 투영의 역상**이어야 한다 (2026-08-01 prod 실측 결함).
        #
        #   표시: checked_in_at 있으면 「체크인」, 없으면 status 투영(expired→취소됨)
        #   필터(옛): `Ticket.status == status` 한 줄 — 두 규칙이 따로 놀았다.
        #
        # 결과로 KLPGA prod 에서 **화면엔 「취소됨」 3건인데 취소 필터는 0건**이었다
        # (expired 티켓 3건). 참석자 화면의 「취소됨」 통계 카드도 같은 필터를 호출하므로
        # 함께 0 이었다. 대회 당일에는 더 크게 걸린다 — 입장하면 티켓이 `used` 가 되는데
        # 「확정」 필터가 `active` 만 보면 **입장한 사람이 확정 목록에서 사라진다.**
        #
        # ⟹ go 어휘를 받아 투영표에서 계산한 집합으로 거르고, checked_in 우선순위도 맞춘다.
        #    v2 어휘(active 등)는 옛 go 를 위해 계속 받는다(배포 순서 v2→go 무관하게 안전).
        key = status.lower()
        if key == "checked_in":
            filters.append(Ticket.checked_in_at.isnot(None))
        elif key in _GO_ATTENDEE_STATUSES:
            filters.append(Ticket.status.in_(
                [TicketStatus(s) for s in _attendee_go_to_v2_list(key)]
            ))
            # 체크인이 표시를 덮어쓰므로, 나머지 필터에서는 **빼야** 화면과 일치한다.
            filters.append(Ticket.checked_in_at.is_(None))
        else:
            try:
                filters.append(Ticket.status == TicketStatus(key))
            except ValueError:
                return _err(ApiError("VALIDATION_ERROR", f"invalid status: {status}", 400, "status"))
    base = (
        select(Ticket, SeatTier.name, SeatTier.external_ref, Order, User)
        .select_from(Ticket)
        .outerjoin(SeatTier, SeatTier.id == Ticket.tier_id)
        .outerjoin(Order, Order.id == Ticket.purchase_order_id)
        .outerjoin(User, User.id == Ticket.current_owner_id)
        .where(*filters)
    )
    if q:
        like = f"%{q}%"
        base = base.where(or_(
            Order.buyer_name.ilike(like), Order.buyer_email.ilike(like),
            User.name.ilike(like), User.email.ilike(like),
        ))
    total = int((await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0)
    rows = (await db.execute(
        base.order_by(Ticket.created_at.desc()).limit(limit).offset(offset)
    )).all()
    attendees = [{
        "ticket_id": str(t.id), "order_id": str(t.purchase_order_id) if t.purchase_order_id else None,
        "owner_user_id": str(t.current_owner_id) if t.current_owner_id else None,
        "name": (o.buyer_name if o and o.buyer_name else (u.name if u else None)),
        "email": (o.buyer_email if o and o.buyer_email else (u.email if u else None)),
        "phone": (o.buyer_phone if o and o.buyer_phone else None),
        "status": t.status.value if hasattr(t.status, "value") else t.status,
        "checked_in_at": t.checked_in_at.isoformat() if t.checked_in_at else None,
        "product_name": name, "seat_id": str(t.seat_id) if t.seat_id else None,
        # #1b: go check_in_lists.product_ids 정확매칭용 — tier_id(v2) + external_ref(go productId).
        "tier_id": str(t.tier_id) if t.tier_id else None,
        "product_external_ref": ext_ref,
        # T2-ORD: go attendees.ticket_number 흡수 — 더 이상 go-local boundary 가 아니다.
        "ticket_number": t.ticket_number,
        "raffle_number": t.raffle_number,
    } for t, name, ext_ref, o, u in rows]
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"attendees": attendees, "total": total, "limit": limit, "offset": offset})


# ── #1 단건 주문 상세 + #1b 단건 티켓 ────────────────────────────────────


@router.get("/orders/by-external/{external_ref}", summary="go read: go 주문 id → 단건 주문 상세")
async def get_order_by_external_ref(external_ref: str, request: Request, response: Response,
                                    db: AsyncSession = Depends(get_db)):
    """W2-PUB — go `orders.id`(external_ref)로 v2 주문을 찾는다.

    go order id 는 event id 와 달리 **canonical 승격되지 않았다**(go orders.id != v2 orders.id).
    그래서 go 가 `SELECT v2_order_id FROM orders WHERE id=$1` 로 하던 앵커 조회를 대체하려면
    v2 쪽 역인덱스 진입점이 필요하다. 나이스 returnUrl 착지(`?orderId=<go order id>`)와
    공개 환불 미리보기가 이 경로로 go DB 없이 주문을 해석한다.

    ⚠️ **정확 매칭만** (LIKE·prefix 금지 — 교차주문 IDOR 차단). `external_ref` 는 UNIQUE.
    """
    o = (await db.execute(
        select(Order).where(Order.external_ref == external_ref).limit(1)
    )).scalar_one_or_none()
    if o is None:
        return _err(ApiError("ORDER_NOT_FOUND", f"order not found for external_ref: {external_ref}", 404))
    return await _order_detail_response(o, response, db)


@router.get("/orders/{order_id}", summary="go read: 단건 주문 상세(items+tickets)")
async def get_order(order_id: uuid.UUID, request: Request, response: Response,
                    db: AsyncSession = Depends(get_db)):
    o = await db.get(Order, order_id)
    if o is None:
        return _err(ApiError("ORDER_NOT_FOUND", f"order not found: {order_id}", 404))
    return await _order_detail_response(o, response, db)


async def _order_detail_response(o: Order, response: Response, db: AsyncSession):
    """단건 주문 상세 응답 — id 조회와 external_ref 조회가 **같은 표현**을 쓰도록 공유."""
    order_id = o.id
    item_rows = (await db.execute(
        select(OrderItem, SeatTier.name, SeatTier.external_ref)
        .select_from(OrderItem)
        .outerjoin(SeatTier, SeatTier.id == OrderItem.tier_id)
        .where(OrderItem.order_id == order_id)
    )).all()
    items = [{
        "tier_id": str(oi.tier_id) if oi.tier_id else None,
        "external_ref": ext, "product_name": name,
        "quantity": oi.quantity, "unit_price": float(oi.unit_price or 0),
        "line_amount": float(oi.line_amount or 0),
        "seat_id": str(oi.seat_id) if oi.seat_id else None,
    } for oi, name, ext in item_rows]
    tk_rows = (await db.execute(
        select(Ticket).where(Ticket.purchase_order_id == order_id)
    )).scalars().all()
    tickets = [{
        "ticket_id": str(t.id),
        "status": t.status.value if hasattr(t.status, "value") else t.status,
        "seat_id": str(t.seat_id) if t.seat_id else None,
        "tier_id": str(t.tier_id) if t.tier_id else None,
        "checked_in_at": t.checked_in_at.isoformat() if t.checked_in_at else None,
    } for t in tk_rows]
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "order_id": str(o.id), "external_order_id": o.external_ref,
        "order_number": o.external_ref or str(o.id), "event_id": str(o.event_id),
        "buyer": {"name": o.buyer_name, "email": o.buyer_email, "phone": o.buyer_phone},
        "status": _go_order_status(o.status),
        "status_v2": o.status.value if hasattr(o.status, "value") else o.status,
        "total_amount": float(o.total_amount or 0),
        "total_refunded": float(o.total_refunded or 0),
        "paid_amount": float(o.total_amount or 0),
        "platform_fee": float(o.platform_fee) if o.platform_fee is not None else None,
        "net_amount": float(o.net_amount) if o.net_amount is not None else None,
        "payment_method": o.pg_provider,
        # 🔴 PG 결제가 이미 걸려 있는 주문인지. go 가 **무통장 입금확정 대상에서 제외**하는 데 쓴다.
        #    go orders 는 소비자 체크아웃 주문도 payment_method='offline' 로 적어 두 경우를
        #    구분하지 못한다 → 그대로 두면 카드 결제 이탈 주문에 "입금 확인" 버튼이 떠서
        #    **돈을 안 받고 티켓이 발권**된다. payment_id 값 자체는 노출하지 않는다.
        "has_pg_payment": bool(o.payment_id),
        # 🔴 초대권에서 나온 주문인가. go 가 결제수단 자리에 「초대권」을 띄우는 근거다.
        #    결제수단(free/offline)으로 판정하면 수동 주문·무료 티켓이 초대권으로 둔갑한다.
        "is_invitation": _tickets_have_answer(tk_rows, _INVITATION_ANSWER_KEY),
        # 🔴 주최자가 화면에서 직접 발권한 0원 주문인가(「주최자 수동발권」).
        #    같은 라우트가 payment_method='offline' 도 적어 종전엔 「현장결제」로 보였다.
        "is_manual_issue": _tickets_have_answer(tk_rows, _MANUAL_ISSUE_ANSWER_KEY),
        # 🔴 상세도 같은 요약을 준다 — 목록에서 본 것을 상세에서 못 보면 담당자가 다시 캔다.
        "payment_attempts": (await _payment_attempt_summaries(db, [o.id])).get(o.id)
        or {"attempt_count": 0, "last_status": None, "last_error_kind": None,
            "last_error": None, "last_at": None},
        "ordered_at": o.created_at.isoformat() if o.created_at else None,
        # ── T2-ORD: go orders 고유 필드(go 제거 후 주문 워크플로·사기탐지·유입경로 유지) ──
        "memo": o.memo,
        "fraud_score": o.fraud_score,
        "fraud_flags": o.fraud_flags,
        "source": o.source,
        "items": items, "tickets": tickets,
    })


@router.get("/organizers/{organizer_ref}/settlements/{settlement_id}", summary="go read: 단건 정산")
async def get_settlement(organizer_ref: str, settlement_id: uuid.UUID, request: Request,
                         response: Response, db: AsyncSession = Depends(get_db)):
    try:
        organizer_id = await _resolve_organizer(db, _parse_org_ref(organizer_ref))
    except ApiError as e:
        return _err(e)
    s = await db.get(OrganizerSettlement, settlement_id)
    if s is None or s.organizer_id != organizer_id:
        return _err(ApiError("SETTLEMENT_NOT_FOUND", f"settlement not found: {settlement_id}", 404))
    org = await db.get(User, organizer_id)
    gross = float(s.gross_revenue or 0)
    order_count = int((await db.execute(
        select(func.count(Order.id)).select_from(Order).join(Event, Event.id == Order.event_id)
        .where(Event.organizer_id == organizer_id, Order.status.in_(_REVENUE_STATUSES),
               Order.created_at >= s.period_start, Order.created_at < s.period_end)
    )).scalar() or 0)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "settlement_id": str(s.id), "organizer_id": str(organizer_id),
        "period_start": s.period_start.isoformat() if s.period_start else None,
        "period_end": s.period_end.isoformat() if s.period_end else None,
        "gross_amount": gross, "platform_fee": float(s.platform_fee or 0),
        "platform_fee_rate": round(float(s.platform_fee or 0) / gross, 4) if gross > 0 else 0.0,
        "pg_fee": float(s.pg_fee or 0), "refund_amount": float(s.total_refunds or 0),
        "net_amount": float(s.net_payout or 0), "order_count": order_count,
        "status": s.status, "paid_at": s.paid_at.isoformat() if s.paid_at else None,
        "memo": s.dispute_reason,
        "bank_name": getattr(org, "settlement_bank", None) if org else None,
        "account_number": getattr(org, "settlement_account_number", None) if org else None,
        "account_holder": getattr(org, "settlement_account_holder", None) if org else None,
    })


async def _admitted_today(db: AsyncSession, ticket_id) -> bool:
    """🔴 **오늘(KST) 입장했는가** — 다일권의 유일한 판정 근거.

    ## 왜 `checked_in_at` 으로 판정하면 안 되는가

    `tickets.checked_in_at` 은 티켓당 **스칼라 하나**다. 주중권(목·금 이틀)은 1일차에
    입장하면 그 값이 채워진 채 남는다 ⟹ **2일차 아침에 QR 이 사라진다.** 손님은 게이트
    앞에서 티켓을 못 연다.

    `event_admissions` 는 `UNIQUE(ticket_id, attended_date)` 로 **날짜별**이다 —
    다일 입장 멱등의 SoT(계약서 CHECKIN-STATE-CONTRACT-F1 §3.1).

    ⚠️ `attended_date` 는 **KST 로컬 날짜**다. UTC `::date` 캐스트 금지 — 자정~09:00 KST
       사이에 어제로 읽힌다(그 시간대가 정확히 게이트 오픈 06:00 을 포함한다).
    """
    from app.models.event_admission import EventAdmission
    from app.services.admission_service import to_kst_date

    today = to_kst_date(datetime.now(timezone.utc))
    return (
        await db.execute(
            select(EventAdmission.id).where(
                EventAdmission.ticket_id == ticket_id,
                EventAdmission.attended_date == today,
            ).limit(1)
        )
    ).scalar_one_or_none() is not None


def _ticket_detail_dict(
    t: Ticket, name, ext, o: Order | None, ev: Event | None,
    *, go_account_id: str | None = None, admitted_today: bool,
    order_tickets: list[dict] | None = None,
) -> dict:
    """단건 티켓 응답 — id 조회와 ticket_number 조회가 **같은 표현**을 쓰도록 공유.

    T2-ORD: go 제거 후 소비자 티켓 페이지(`/tickets/{ticket_number}`)·QR·PDF·지갑이
    go `attendees`/`orders`/`events` JOIN 없이 이 응답 하나로 구성돼야 한다.

    W2-ORD(가산): `event.go_account_id`·`event.venue` 추가. go 티켓 산출물
    (QR/PDF/Apple·Google 지갑)은 접근제어에 go `events.account_id`, 표시에
    `events.venue_name` 이 필요했는데 그게 go events 를 읽는 **유일한 이유**였다.
    여기서 함께 내려주면 go 는 티켓 산출물 경로에서 go DB 를 아예 안 읽는다.
    기존 필드는 그대로 — 순수 가산이라 기존 소비자(mobile/consumer) 계약 무변.
    """
    return {
        "ticket_id": str(t.id),
        # T2-ORD: 소비자 티켓 URL 키(go attendees.ticket_number 흡수).
        "ticket_number": t.ticket_number,
        "status": t.status.value if hasattr(t.status, "value") else t.status,
        "checked_in_at": t.checked_in_at.isoformat() if t.checked_in_at else None,
        # 🔴 오늘(KST) 입장했는가 — 티켓 페이지가 QR ↔ 라이브를 가르는 값.
        #    `checked_in_at` 은 티켓당 스칼라 하나라 **2일차에 QR 이 사라진다**(주중권 목·금).
        #    날짜별 원장(event_admissions)만이 다일권을 옳게 답한다.
        "admitted_today": admitted_today,
        "seat_id": str(t.seat_id) if t.seat_id else None,
        "tier_id": str(t.tier_id) if t.tier_id else None,
        "product_name": name, "product_external_ref": ext,
        "raffle_number": t.raffle_number,
        # T2-ORD: 예매 설문 응답(go attendees.answers 흡수).
        "answers": t.answers,
        # W2-PUB — 발급 시각(구 go `attendees.created_at`). 초대권 화면이 표시한다.
        "issued_at": t.created_at.isoformat() if t.created_at else None,
        "event_id": str(t.event_id),
        "event": {
            "starts_at": ev.event_date.isoformat() if ev and ev.event_date else None,
            "title": ev.title if ev else None,
            # 주최자 경계 — go 는 events.account_id 로 티켓 접근권을 판정했다.
            "organizer_id": str(ev.organizer_id) if ev and ev.organizer_id else None,
            "external_ref": ev.external_ref if ev else None,
            # W2-ORD: go events 대체분. go_account_id 는 접근제어(주최자 세션 소유검증) 정본,
            # venue 는 지갑/PDF 표시용(구 go events.venue_name).
            "go_account_id": go_account_id,
            "venue": ev.venue if ev else None,
        },
        "order": {
            "id": str(t.purchase_order_id) if t.purchase_order_id else None,
            "order_number": (o.external_ref or str(o.id)) if o else None,
            # W2-PUB — go order id 원본. `order_number` 는 external_ref 부재 시 v2 id 로
            # 폴백하므로 "go 주문 id 인지" 판별에 쓸 수 없다(환불 접수 원장 키가 go orders FK).
            "external_ref": o.external_ref if o else None,
            "buyer": {"name": o.buyer_name, "email": o.buyer_email, "phone": o.buyer_phone} if o else None,
            # 🔴 같은 주문의 티켓 전부(자기 포함, 초대권 제외) — 화면이 「1/4 ◀▶」로
            #    넘길 수 있게 한다. 기본값 [] 이라 안 넘긴 호출부는 종전과 동일하다
            #    (id 조회는 아직 안 쓴다 — 쓰는 화면이 생기면 그때 넘긴다).
            "tickets": order_tickets or [],
        },
    }


async def _order_sibling_tickets(
    db: AsyncSession, order_id: uuid.UUID | None,
) -> list[dict]:
    """같은 주문의 티켓 전부(자기 포함) — 「N장 샀는데 QR 이 하나만 보인다」를 푸는 값.

    ## 왜 필요한가 (2026-08-19, 대회 D-1 실측)

    구매완료 알림톡·메일의 딥링크는 **첫 장 하나**다(`notifyPurchaseConfirm` 의
    "대표 티켓번호"). 티켓 화면에도 나머지로 가는 길이 없어서, 2장 이상 산 구매자는
    자기가 산 티켓 중 1장밖에 못 연다.

        prod 실측: 유료 복수구매 54명 · 120장 → **64장이 링크로 닿지 않았다**

    구제 경로(`/my-tickets` 이메일+전화)는 있지만 **버튼이 있는 메일은 그걸 안내하지
    않는다**. 즉 길은 있는데 아무도 모른다.

    ## 🔴 초대권은 뺀다 — 여기가 유일한 위험 지점

    초대권은 **장마다 주인이 다르다**(1인 다장 상한 50, 양도 기능 있음). 같은 주문에
    묶여 있다는 이유로 형제를 보여주면 **남의 초대권이 열린다**. 그래서 표식
    (`_invitationId`)이 있는 티켓은 목록에서 제외한다 — 주문 묶음이 아니라 **표식**으로
    자른다(주문 구조가 바뀌어도 경계가 안 무너지게).

    유료 티켓은 반대다. 한 주문의 티켓은 **한 사람이 산 것**이고, 그 사람은 이미 이
    주문의 티켓 하나에 대한 유효 토큰을 들고 들어왔다. 형제를 보여주는 것은 새 권한을
    여는 게 아니라 같은 사람에게 같은 주문을 보여주는 것이다.
    """
    if order_id is None:
        return []
    rows = (await db.execute(
        select(Ticket.ticket_number, Ticket.status, Ticket.admission_day)
        .where(
            Ticket.purchase_order_id == order_id,
            Ticket.ticket_number.isnot(None),
            # 🔴 초대권 제외. `.as_string()` 을 반드시 거친다 — 없으면 SQLite 에서
            #    공허하게 참이 되어 **초대권이 하나도 안 걸러진다**
            #    (`_order_has_ticket_answer_sql` 의 실측 주석 참조).
            Ticket.answers[_INVITATION_ANSWER_KEY].as_string().is_(None),
        )
        .order_by(Ticket.created_at.asc(), Ticket.id.asc())
    )).all()
    return [{
        "ticket_number": n,
        "status": st.value if hasattr(st, "value") else st,
        "admission_day": day.isoformat() if day else None,
    } for n, st, day in rows]


_TICKET_DETAIL_SELECT = (
    select(Ticket, SeatTier.name, SeatTier.external_ref, Order, Event)
    .select_from(Ticket)
    .outerjoin(SeatTier, SeatTier.id == Ticket.tier_id)
    .outerjoin(Order, Order.id == Ticket.purchase_order_id)
    .outerjoin(Event, Event.id == Ticket.event_id)
)


@router.get("/tickets/{ticket_id}", summary="go read: 단건 티켓")
async def get_ticket(ticket_id: uuid.UUID, request: Request, response: Response,
                     db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        _TICKET_DETAIL_SELECT.where(Ticket.id == ticket_id)
    )).first()
    if row is None:
        return _err(ApiError("TICKET_NOT_FOUND", f"ticket not found: {ticket_id}", 404))
    t, name, ext, o, ev = row
    go_account_id = await _go_account_id_of(db, ev.organizer_id) if ev and ev.organizer_id else None
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_ticket_detail_dict(
        t, name, ext, o, ev, go_account_id=go_account_id,
        admitted_today=await _admitted_today(db, t.id),
    ))


@router.get("/tickets/by-number/{ticket_number}", summary="go read: 티켓번호 단건 조회")
async def get_ticket_by_number(ticket_number: str, request: Request, response: Response,
                               db: AsyncSession = Depends(get_db)):
    """T2-ORD: 소비자 티켓 URL 키(`ticket_number`) 진입점.

    go `attendees.ticket_number` 가 정본이던 경로(`/tickets/[n]`·QR·PDF·Apple/Google 지갑)를
    v2 단독으로 서비스하기 위한 조회. 번호 체계·값은 go 와 동일(`derive_ticket_number`)이라
    **이미 배포된 링크·지갑 패스가 그대로 유효**하다.
    """
    row = (await db.execute(
        _TICKET_DETAIL_SELECT.where(Ticket.ticket_number == ticket_number).limit(1)
    )).first()
    if row is None:
        return _err(ApiError("TICKET_NOT_FOUND", f"ticket not found: {ticket_number}", 404))
    t, name, ext, o, ev = row
    go_account_id = await _go_account_id_of(db, ev.organizer_id) if ev and ev.organizer_id else None
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_ticket_detail_dict(
        t, name, ext, o, ev, go_account_id=go_account_id,
        admitted_today=await _admitted_today(db, t.id),
        # 🔴 이 조회에만 붙인다 — 소비자 티켓 페이지의 진입점이 여기다.
        order_tickets=await _order_sibling_tickets(db, t.purchase_order_id),
    ))


def _csv_response(header: list[str], rows: list[list]) -> PlainTextResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow(r)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@router.get("/events/{event_id}/orders/export", summary="go read: 주문 CSV")
async def export_orders(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rows = (await db.execute(
        select(Order).where(Order.event_id == event_id).order_by(Order.created_at.desc())
    )).scalars().all()
    return _csv_response(
        ["order_id", "external_ref", "buyer_name", "buyer_email", "total_amount",
         "total_refunded", "status", "payment_method", "ordered_at"],
        [[str(o.id), o.external_ref or "", o.buyer_name or "", o.buyer_email or "",
          float(o.total_amount or 0), float(o.total_refunded or 0), _go_order_status(o.status),
          o.pg_provider or "", o.created_at.isoformat() if o.created_at else ""] for o in rows],
    )


@router.get("/events/{event_id}/attendees/export", summary="go read: 참석자 CSV")
async def export_attendees(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rows = (await db.execute(
        select(Ticket, SeatTier.name).select_from(Ticket)
        .outerjoin(SeatTier, SeatTier.id == Ticket.tier_id)
        .where(Ticket.event_id == event_id).order_by(Ticket.created_at.desc())
    )).all()
    return _csv_response(
        ["ticket_id", "order_id", "owner_user_id", "product_name", "status", "checked_in_at"],
        [[str(t.id), str(t.purchase_order_id or ""), str(t.current_owner_id or ""), name or "",
          t.status.value if hasattr(t.status, "value") else t.status,
          t.checked_in_at.isoformat() if t.checked_in_at else ""] for t, name in rows],
    )


# ── 정정6: live 스냅샷 + forecast + reports/export ───────────────────────


@router.get("/events/{event_id}/live", summary="go read: 실시간 대시보드 스냅샷(폴링)")
async def event_live(event_id: uuid.UUID, request: Request, response: Response,
                     db: AsyncSession = Depends(get_db)):
    """정정6 — SSE 대체 스냅샷. go 가 폴링(또는 추후 SSE 레이어). 매출/체크인/잔여재고."""
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    rev = await _revenue_block(db, Order.event_id == event_id)
    cap = (await db.execute(
        select(
            func.coalesce(func.sum(SeatTier.capacity - SeatTier.sold_count), 0),
            func.coalesce(func.sum(SeatTier.capacity), 0),
        ).where(SeatTier.event_id == event_id)
    )).first()
    stock = int(cap[0] or 0)
    total_stock = int(cap[1] or 0)
    response.headers["Cache-Control"] = "no-store"  # 실시간 — 캐시 금지
    return _ok({
        "net_revenue": rev["net_revenue"], "order_count": rev["order_count"],
        "checked_in_count": await _checked_in_count(db, event_id),
        "total_attendees": await _attendee_count(db, event_id),  # 🟠5 진행률 분모
        "stock_remaining": stock, "total_stock": total_stock,    # 🟠5 잔여 바 분모
        "ts": datetime.now(timezone.utc).isoformat(),
    })


@router.get("/events/{event_id}/analytics/forecast", summary="go read: 일별 판매추이(예측 입력)")
async def analytics_forecast(event_id: uuid.UUID, request: Request, response: Response,
                             db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"daily_sales": await _daily_sales(db, event_id)})


@router.get("/events/{event_id}/reports/export", summary="go read: 매출 리포트 CSV")
async def reports_export(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    daily = await _daily_sales(db, event_id)
    return _csv_response(["date", "net_amount", "order_count"],
                         [[d["date"], d["amount"], d["count"]] for d in daily])


# ════════════════════════════════════════════════════════════════════════
# W2-PUB — 공개(비인증) go 라우트를 go DB 없이 렌더하기 위한 read 3종
#
# go 가 지우는 SQL 과 1:1 대응:
#   · `SELECT ... FROM events WHERE status='live' [AND 'marketplace'=ANY(sale_channels)]`
#     (공개 목록 API·sitemap·랜딩 그리드)        → GET  /internal/public/events
#   · `SELECT COUNT(*) FROM attendees|events`    → GET  /internal/public/stats
#   · `SELECT ... FROM attendees JOIN events
#      WHERE email=$1 AND phone=$2`(내 티켓)     → POST /internal/public/ticket-lookup
#
# 🔴 조용한 폴백 금지 — 이 엔드포인트가 죽으면 go 는 "빈 목록"이 아니라 503 을 낸다.
#    (빈 목록 위장은 판매중인 이벤트가 사라진 화면을 조용히 띄운다.)
# 🔴 상태 게이트는 **서버가** 강제한다 — 공개 목록에서 draft/paused/archived 를 절대 흘리지
#    않기 위해, 상세(by-slug)와 달리 호출측 판정에 맡기지 않는다.
# ════════════════════════════════════════════════════════════════════════

_PUBLIC_LIST_MAX = 200
# go `WHERE status = 'live'` 의 v2 등가 — project_event_status 가 "live" 로 투영하는 원본 상태들.
_LIVE_V2_EVENT_STATUSES = [EventStatus(s) for s in event_go_to_v2_list("live")]


def _sale_channel_filter(db: AsyncSession, channel: str):
    """`'<channel>' = ANY(sale_channels)` 의 방언 중립 술어.

    `Event.sale_channels` 는 PG `ARRAY(Text)` / SQLite `JSON` variant 라 같은 표현식이
    양쪽에서 컴파일되지 않는다. 기존 `events.py` 는 pytest 환경에서 필터를 통째로
    **always-true 로 스킵**했는데(= 채널 게이트 무검증), 공개 목록에서 그건 위험하다
    ("self 전용" 이벤트가 마켓에 새는 회귀를 테스트가 못 잡는다).
    → 방언별로 동치 술어를 만들어 **두 환경 모두에서 실제로 필터**한다.
    """
    try:
        dialect = db.get_bind().dialect.name
    except Exception:  # noqa: BLE001 — 바인드 미해결 시 PG(운영) 기준으로 간다
        dialect = "postgresql"
    if dialect == "postgresql":
        return Event.sale_channels.contains([channel])
    # SQLite: JSON 배열 텍스트(`["self","marketplace"]`) — 인용부호 포함 매칭으로
    # 부분문자열 오탐(예: "marketplace-beta")을 줄인다.
    return cast(Event.sale_channels, Text).like(f'%"{channel}"%')


def _live_event_filters() -> list:
    """go `WHERE events.status = 'live'` 의 v2 등가 필터.

    sales_paused=True 는 go 투영에서 "paused" 이므로 공개 목록에서 제외한다
    (go 도 `status='live'` 로만 걸었고 paused 는 별도 status 였다 — 동일 결과).
    """
    return [Event.status.in_(_LIVE_V2_EVENT_STATUSES), Event.sales_paused.is_(False)]


def _public_event_row(e: Event, attendee_count: int, tier_count: int) -> dict:
    """공개 목록 1행 — go `events` SELECT 가 쓰던 컬럼의 v2 대응."""
    return {
        "event_id": str(e.id),
        "external_ref": e.external_ref,
        "slug": e.slug,
        "title": e.title,
        "summary": e.summary,
        "description": e.description,
        "venue": e.venue,
        "venue_address": e.venue_address,
        "venue_lat": e.venue_lat,
        "venue_lng": e.venue_lng,
        "event_type": e.event_type,
        "category": e.category,
        "age_rating": e.age_rating,
        "is_online": bool(e.is_online),
        "event_date": e.event_date.isoformat() if e.event_date else None,
        "event_date_end": e.event_date_end.isoformat() if e.event_date_end else None,
        "image_url": e.image_url,
        "image_variants": e.image_variants or None,
        # go 투영 status — 필터상 항상 "live" 지만 호출측이 재확인할 수 있게 실어 보낸다.
        "status": _project_event_status(e.status, e.sales_paused),
        "sale_channels": list(e.sale_channels or []),
        "total_seats": e.total_seats,
        "attendee_count": attendee_count,
        "tier_count": tier_count,
        "updated_at": e.updated_at.isoformat() if e.updated_at else None,
    }


@router.get("/public/events", summary="go read: 공개 이벤트 목록(마켓/랜딩/사이트맵)")
async def public_events(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    channel: str | None = None,
    sort: str = "date",
    limit: int = 50,
    offset: int = 0,
):
    """공개 이벤트 목록.

    - `channel` — sale_channels 포함 필터(go `'marketplace' = ANY(sale_channels)` 대응).
      미지정이면 채널 무관 전체 live(= go sitemap/랜딩 그리드 동작).
    - `sort` — `date`(event_date ASC, 기본) | `updated`(updated_at DESC, sitemap 용).
    """
    limit = max(1, min(limit, _PUBLIC_LIST_MAX))
    offset = max(0, offset)

    filters = _live_event_filters()
    if channel:
        filters.append(_sale_channel_filter(db, channel))

    total = int((await db.execute(
        select(func.count()).select_from(Event).where(*filters)
    )).scalar() or 0)

    order_clause = (
        Event.updated_at.desc() if sort == "updated" else Event.event_date.asc()
    )
    rows = (await db.execute(
        # 동률 시 페이지 경계에서 행이 중복·누락되지 않도록 id 로 tie-break.
        select(Event).where(*filters).order_by(order_clause, Event.id.asc())
        .limit(limit).offset(offset)
    )).scalars().all()

    ids = [e.id for e in rows]
    agg = await _event_order_aggregates(db, ids)
    tier_counts: dict[uuid.UUID, int] = {}
    if ids:
        for ev_id, cnt in (await db.execute(
            select(SeatTier.event_id, func.count())
            .where(SeatTier.event_id.in_(ids)).group_by(SeatTier.event_id)
        )).all():
            tier_counts[ev_id] = int(cnt or 0)

    events = [
        _public_event_row(
            e,
            int(agg.get(e.id, {}).get("attendee_count", 0)),
            tier_counts.get(e.id, 0),
        )
        for e in rows
    ]
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"events": events, "total": total, "limit": limit, "offset": offset})


@router.get("/public/stats", summary="go read: 공개 랜딩 소셜프루프 집계")
async def public_stats(request: Request, response: Response,
                       db: AsyncSession = Depends(get_db)):
    """go 랜딩 `COUNT(*) FROM attendees|events` 의 v2 대응.

    ⚠️ 분모가 **플랫폼 전체(v2)** 다 — go DB 만 세던 예전 숫자보다 커진다(v2 가 SoT).
    """
    event_count = int((await db.execute(select(func.count()).select_from(Event))).scalar() or 0)
    live_event_count = int((await db.execute(
        select(func.count()).select_from(Event).where(*_live_event_filters())
    )).scalar() or 0)
    ticket_count = int((await db.execute(select(func.count()).select_from(Ticket))).scalar() or 0)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "event_count": event_count,
        "live_event_count": live_event_count,
        "ticket_count": ticket_count,
    })


class PublicTicketLookupRequest(BaseModel):
    """구매 이메일 + 전화 지식 기반 티켓 조회 입력.

    PII 라 **POST 본문**으로 받는다(쿼리스트링은 액세스 로그·리퍼러에 남는다).
    """
    email: str
    phone: str
    limit: int = 100


# 마이그 직후 아직 blind-index 백필되지 않은 동일 이메일 주문을 앱에서 복호화 비교한다.
# 무제한 복호화는 공개 입력으로 DB/CPU를 소진할 수 있으므로 상한 초과는 빈 결과로 위장하지
# 않고 503을 반환한다. backfill 완료 후 이 분기는 0행이 된다.
_MAX_LEGACY_PHONE_LOOKUP_ORDERS = 500


@router.post("/public/ticket-lookup", summary="go read: 구매자 이메일+전화 → 티켓 목록")
async def public_ticket_lookup(
    body: PublicTicketLookupRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """go `attendees JOIN events WHERE email=$1 AND phone=$2` 의 v2 대응.

    ⚠️ 매칭 기준 변화: go 는 **참석자(attendee)** 연락처, v2 는 **주문 구매자(buyer)** 연락처다.
       v2 는 티켓별 참석자 연락처를 보관하지 않는다(구매자만 SoT). 단건 구매는 동일하고,
       대량구매에서 참석자별 이메일을 따로 넣은 경우만 조회 범위가 구매자 기준으로 좁아진다.
    ⚠️ 열거 방지는 **호출측(go)** 책임 — 여기서는 매칭 결과를 그대로 돌려준다.
    """
    email = (body.email or "").strip()
    phone = (body.phone or "").strip()
    normalized_phone = normalize_phone_for_lookup(phone)
    if not email or normalized_phone is None:
        return _err(ApiError("VALIDATION_ERROR", "email/phone 은 필수입니다", 400, "email"))
    limit = max(1, min(int(body.limit or 100), 500))

    # Fernet은 같은 평문도 매번 다른 ciphertext가 되므로 buyer_phone == :phone 비교는
    # 영원히 일치하지 않는다. keyed blind index(HMAC)를 SQL 조회키로 사용한다.
    order_ids: set[uuid.UUID] = set()
    lookup_digests = phone_lookup_digests(phone)
    if lookup_digests:
        order_ids.update(
            (await db.execute(
                select(Order.id).where(
                    func.lower(Order.buyer_email) == email.lower(),
                    Order.buyer_phone_lookup_hash.in_(lookup_digests),
                )
            )).scalars().all()
        )

    # 배포 순서(add column → app → backfill) 동안 기존 주문은 hash가 NULL이다. 정확한
    # 이메일로 후보를 좁힌 뒤 ORM 복호화값을 비교해 셀프환불 진입이 백필 완료까지 막히지
    # 않게 한다. 이 경로에서 hash가 있는 행은 절대 복호화 스캔하지 않는다.
    legacy_candidates = (await db.execute(
        select(Order.id, Order.buyer_phone)
        .where(
            func.lower(Order.buyer_email) == email.lower(),
            Order.buyer_phone_lookup_hash.is_(None),
        )
        .limit(_MAX_LEGACY_PHONE_LOOKUP_ORDERS + 1)
    )).all()
    if len(legacy_candidates) > _MAX_LEGACY_PHONE_LOOKUP_ORDERS:
        return _err(ApiError(
            "PHONE_LOOKUP_BACKFILL_REQUIRED",
            "전화번호 조회 인덱스 백필이 필요합니다",
            503,
        ))
    order_ids.update(
        order_id
        for order_id, candidate_phone in legacy_candidates
        if normalize_phone_for_lookup(candidate_phone) == normalized_phone
    )

    if not order_ids:
        response.headers["Cache-Control"] = "no-store"
        return _ok({"tickets": [], "total": 0})

    rows = (await db.execute(
        select(Ticket, SeatTier.name, Order, Event)
        .select_from(Ticket)
        .outerjoin(SeatTier, SeatTier.id == Ticket.tier_id)
        .join(Order, Order.id == Ticket.purchase_order_id)
        .outerjoin(Event, Event.id == Ticket.event_id)
        # 🔴 죽은 표를 목록에서 뺀다 (2026-08-20 대회 중 실사고).
        #
        #    결제창에서 한 번이라도 시간이 초과되면 그 주문의 티켓이 `expired` 로 남는다.
        #    종전엔 그것까지 함께 내려보내, 재구매에 성공한 손님 화면에서 **유효한 표가
        #    죽은 표에 묻혔다**. 손님은 위에 있는 걸 누르고 "만료" 화면을 본다.
        #    실측: 구매자 34명 · 죽은 표 100장. 대회 첫날 민원이 종일 들어왔다.
        #
        #    ⚠️ `used`(입장 완료)는 **남긴다** — 종일 입장이라 재입장·경품추첨에 계속 쓴다.
        #    ⚠️ 🔴 `cancelled` 도 **남긴다.** 환불받은 손님은 그 표가 보여야 "환불됨" 을 안다
        #       (화면이 `환불·취소된 티켓입니다` 로 안내한다). 실측: 유효표 없이 취소표만
        #       가진 손님이 38명 — 함께 자르면 그분들 화면이 텅 비어 "내 티켓이 사라졌다"
        #       민원이 **새로** 생긴다. 빼는 것은 `expired` 하나뿐이다.
        .where(
            Order.id.in_(order_ids),
            Ticket.status != TicketStatus.EXPIRED,
        )
        # go 정렬(events.starts_at DESC, attendees.created_at DESC) 과 동일.
        .order_by(Event.event_date.desc(), Ticket.created_at.desc(), Ticket.id.asc())
        .limit(limit)
    )).all()

    tickets = [{
        "ticket_id": str(t.id),
        "ticket_number": t.ticket_number,
        "name": o.buyer_name if o else None,
        "status": t.status.value if hasattr(t.status, "value") else t.status,
        "product_name": tier_name,
        "event_id": str(t.event_id),
        "event_title": ev.title if ev else None,
        "event_starts_at": ev.event_date.isoformat() if ev and ev.event_date else None,
        "event_venue": ev.venue if ev else None,
    } for t, tier_name, o, ev in rows]

    response.headers["Cache-Control"] = "no-store"  # PII 응답 — 캐시 금지
    return _ok({"tickets": tickets, "total": len(tickets)})
