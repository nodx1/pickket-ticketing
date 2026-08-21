"""Celery task: organizer 정산 생성 (단계4d-2b) + 클로백/재판매 분리 (블로커 #4/#6).

MASTER N4/N5: 정산을 매 조회 역산(비결정)하던 것 → 주문 확정 시점 동결한 fee
(order.platform_fee/pg_fee, 4d-1)를 기간·organizer별로 SUM해 OrganizerSettlement row 생성.
- 역산 금지: 동결값만 합산(재계산 X).
- 기존 주문(4d-1 이전)은 platform_fee NULL → coalesce 0. 단계6 백필 후 정확.
- 중복(organizer, period, settlement_type) skip — 멱등.
- 기본 기간: 지난 캘린더월(beat, 멱등) 또는 인자 지정(period_start_iso/period_end_iso).
- 상태 draft 생성 → 운영자 review→approve→paid (settlement.py 워크플로).

블로커 #4 — 클로백:
- 정산 생성 이후 발생한 환불·차지백(order.total_refunded 증가분)을 다음 실행 시
  현재 기간 정산에 음수 SettlementAdjustment(type='clawback')로 차감.
- 불변식: settlement.total_refunds + settlement.refunds_clawed
          == 현재 시점 해당 기간의 환불등가액(_refund_equivalent).
- refunds_clawed IS NULL 인 legacy 정산은 스캔 제외(원장 소급 불가 — 수동 조정).
- 모집단 상태셋(CONFIRMED/PAID/PARTIALLY_REFUNDED/REFUNDED)은 전이 폐쇄집합이라
  재계산이 시점 불변(생성 당시 CONFIRMED → 이후 REFUNDED 여도 동일 모집단).
  주: 환불된 주문도 gross/fee에 포함되고 환불액이 차감되므로 수수료는
  환불 여부와 무관하게 동일하게 부과된다(타이밍 일관성 — 정책 확정 시 조정).

블로커 #6 — 재판매 분리:
- RESALE_BUY 주문은 주최자 정산 gross에서 제외.
- payment_metadata.resale 분배(seller_receives/artist_royalty/platform_fee)에 따라
  판매자 정산 row(settlement_type='resale_seller', organizer_id=판매자 user id) 생성,
  artist_royalty는 주최자 정산에 양수 조정(type='resale_royalty')으로 귀속.
"""
import logging
import uuid
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from sqlalchemy import select, func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from celery import shared_task

from app.core.database import SyncSession
from app.models.order import Order, OrderStatus, OrderType
from app.models.event import Event
from app.models.settlement import (
    OrganizerSettlement,
    SettlementAdjustment,
    SettlementStatus,
    SettlementType,
)

logger = logging.getLogger(__name__)

_CENT = Decimal("0.01")

# 정산 모집단 상태셋 — 전이 폐쇄집합(이탈 전이 없음)이라 클로백 재계산이 시점 불변.
_SETTLEABLE_STATUSES = [
    OrderStatus.CONFIRMED,
    OrderStatus.PAID,
    OrderStatus.PARTIALLY_REFUNDED,
    OrderStatus.REFUNDED,
]

# 클로백 조정을 붙일 수 있는(아직 지급 라인이 확정되지 않은) 정산 상태
_CLAWBACK_TARGETABLE = {SettlementStatus.DRAFT.value, SettlementStatus.PENDING_REVIEW.value}


def _dec(value) -> Decimal:
    return Decimal(str(value if value is not None else 0)).quantize(_CENT)


# 동시성 직렬화용 advisory lock 네임스페이스(임의 고정 상수) — generate_settlements 전용.
_SETTLEMENT_LOCK_NS = 0x5E771E  # "settle"


def _acquire_period_lock(session: Session, period_start: datetime, period_end: datetime) -> None:
    """기간 단위 PostgreSQL advisory transaction lock 으로 동시 실행을 직렬화.

    월 정산 beat + 수동 재실행/Celery 재시도가 같은 기간을 동시에 처리하면
    둘 다 정산 row 를 INSERT/클로백 적용 → 환불 이중 클로백 + 중복 row.
    같은 (period_start, period_end) 키로 xact lock 을 잡아 두 번째 실행을 첫 번째의
    커밋/롤백까지 차단한다. 잠금 해제 후 진입한 실행은 이미 생성된 row 를 보고 멱등 skip.

    sqlite(테스트)에는 advisory lock 이 없으므로 no-op (dialect 분기).
    """
    if session.bind.dialect.name != "postgresql":
        return
    key = f"settlement:{period_start.isoformat()}:{period_end.isoformat()}"
    session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:key))"),
        {"ns": _SETTLEMENT_LOCK_NS, "key": key},
    )


def _add_settlement_idempotent(
    session: Session,
    settlement: OrganizerSettlement,
    key: tuple[uuid.UUID, str],
) -> tuple[OrganizerSettlement, bool]:
    """정산 row 를 INSERT 하되 UNIQUE 제약 충돌 시 기존 활성 row 를 재사용.

    advisory lock 이 동시 실행을 직렬화하지만, lock 우회 경로(다른 코드/수동 INSERT)나
    advisory lock 미지원 환경에서도 (organizer, period, type) UNIQUE 제약이
    중복 INSERT 를 차단한다. 그 backstop 으로 IntegrityError 를 잡아 기존 row 로 우아하게
    수렴시킨다. 반환: (사용할 settlement, 새로 생성됐는지 여부).
    """
    savepoint = session.begin_nested()
    try:
        session.add(settlement)
        session.flush()
        savepoint.commit()
        return settlement, True
    except IntegrityError:
        savepoint.rollback()
        existing = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == settlement.organizer_id,
                OrganizerSettlement.period_start == settlement.period_start,
                OrganizerSettlement.period_end == settlement.period_end,
                OrganizerSettlement.settlement_type == settlement.settlement_type,
                OrganizerSettlement.deleted_at.is_(None),
            )
        ).scalar_one()
        logger.warning(
            "settlement 중복 INSERT 차단(UNIQUE) — 기존 row 재사용 "
            "(organizer=%s type=%s period=%s~%s)",
            settlement.organizer_id, settlement.settlement_type,
            settlement.period_start, settlement.period_end,
        )
        return existing, False


def _refund_fraction(order: Order) -> Decimal:
    """주문 환불 비율 (0~1). 재판매 분배액 클로백 비례 배분용."""
    total = _dec(order.total_amount)
    if total <= 0:
        return Decimal("0")
    fraction = _dec(order.total_refunded) / total
    return min(fraction, Decimal("1"))


def _resale_split(order: Order) -> dict | None:
    """RESALE_BUY 주문의 payment_metadata.resale 분배 정보. 없으면 None."""
    meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
    resale = meta.get("resale") if isinstance(meta.get("resale"), dict) else None
    if not resale or not resale.get("seller_id"):
        logger.warning(
            "settlement: RESALE_BUY 주문에 resale 분배 메타 없음 — 정산 제외 order=%s",
            order.id,
        )
        return None
    try:
        return {
            "seller_id": uuid.UUID(str(resale["seller_id"])),
            "seller_receives": _dec(resale.get("seller_receives")),
            "artist_royalty": _dec(resale.get("artist_royalty")),
        }
    except (ValueError, TypeError):
        logger.warning("settlement: resale 메타 파싱 실패 — 정산 제외 order=%s", order.id)
        return None


def _resale_orders(
    session: Session, period_start: datetime, period_end: datetime
) -> list[tuple[Order, uuid.UUID]]:
    """기간 내 정산 대상 RESALE_BUY 주문 + 이벤트 주최자 id."""
    rows = session.execute(
        select(Order, Event.organizer_id)
        .join(Event, Event.id == Order.event_id)
        .where(
            Order.order_type == OrderType.RESALE_BUY,
            Order.status.in_(_SETTLEABLE_STATUSES),
            Order.created_at >= period_start,
            Order.created_at < period_end,
            Order.deleted_at.is_(None),
        )
    ).all()
    return [(order, organizer_id) for order, organizer_id in rows]


def _refund_equivalent(
    session: Session,
    beneficiary_id: uuid.UUID,
    period_start: datetime,
    period_end: datetime,
    settlement_type: str,
) -> Decimal:
    """현재 시점 기준, 해당 수취인·기간 정산에서 차감됐어야 할 환불 등가액.

    - organizer: 1차 판매 주문 total_refunded 합 + 재판매 로열티의 환불 비례분.
    - resale_seller: 재판매 seller_receives 의 환불 비례분.
    클로백 불변식(total_refunds + refunds_clawed == 이 값)의 기준 함수.
    """
    total = Decimal("0")
    if settlement_type == SettlementType.ORGANIZER.value:
        primary = session.execute(
            select(func.coalesce(func.sum(Order.total_refunded), 0))
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == beneficiary_id,
                Order.order_type != OrderType.RESALE_BUY,
                Order.status.in_(_SETTLEABLE_STATUSES),
                Order.created_at >= period_start,
                Order.created_at < period_end,
                Order.deleted_at.is_(None),
            )
        ).scalar_one()
        total += _dec(primary)
        for order, organizer_id in _resale_orders(session, period_start, period_end):
            if organizer_id != beneficiary_id:
                continue
            split = _resale_split(order)
            if split:
                total += (split["artist_royalty"] * _refund_fraction(order)).quantize(_CENT)
    else:
        for order, _organizer_id in _resale_orders(session, period_start, period_end):
            split = _resale_split(order)
            if split and split["seller_id"] == beneficiary_id:
                total += (split["seller_receives"] * _refund_fraction(order)).quantize(_CENT)
    return total.quantize(_CENT)


def _apply_clawbacks(
    session: Session,
    period_start: datetime,
    period_end: datetime,
    current_by_key: dict[tuple[uuid.UUID, str], OrganizerSettlement],
) -> tuple[int, Decimal]:
    """블로커 #4: 확정 정산 이후 증가한 환불을 현재 기간 정산에서 차감.

    이전 기간 정산(refunds_clawed 추적 대상) 각각에 대해
    delta = 현재 환불등가액 - (total_refunds + refunds_clawed) 를 계산,
    delta > 0 이면 현재 기간 정산에 음수 조정(type='clawback')을 만들고
    원 정산의 refunds_clawed 에 누적한다(멱등 — 재실행 시 delta=0).
    """
    clawed_count = 0
    clawed_total = Decimal("0")

    # with_for_update: 클로백 대상 prior row 를 잠가, advisory lock 을 우회한 동시
    # 실행이라도 같은 prior 의 refunds_clawed 를 동시에 누적하지 못하게 한다(이중 클로백 방지).
    # sqlite(테스트)는 행 잠금을 지원하지 않으나 SQLAlchemy 가 조용히 무시한다.
    prior_settlements = session.execute(
        select(OrganizerSettlement).where(
            OrganizerSettlement.period_end <= period_start,
            OrganizerSettlement.refunds_clawed.is_not(None),
            OrganizerSettlement.deleted_at.is_(None),
        ).with_for_update()
    ).scalars().all()

    for prior in prior_settlements:
        f_now = _refund_equivalent(
            session,
            prior.organizer_id,
            prior.period_start,
            prior.period_end,
            prior.settlement_type,
        )
        accounted = _dec(prior.total_refunds) + _dec(prior.refunds_clawed)
        delta = (f_now - accounted).quantize(_CENT)
        if delta <= 0:
            continue

        key = (prior.organizer_id, prior.settlement_type)
        target = current_by_key.get(key)
        if target is None:
            # 현재 기간 활동이 없어도 클로백은 회수해야 함 — 0원 정산 row 생성
            target = OrganizerSettlement(
                organizer_id=prior.organizer_id,
                settlement_type=prior.settlement_type,
                period_start=period_start,
                period_end=period_end,
                gross_revenue=Decimal("0"),
                total_refunds=Decimal("0"),
                platform_fee=Decimal("0"),
                pg_fee=Decimal("0"),
                net_payout=Decimal("0"),
                refunds_clawed=Decimal("0"),
                status=SettlementStatus.DRAFT.value,
            )
            target, _is_new = _add_settlement_idempotent(session, target, key)
            current_by_key[key] = target
        elif target.status not in _CLAWBACK_TARGETABLE:
            # 이미 승인/지급 단계로 넘어간 정산은 건드리지 않는다.
            # refunds_clawed 미반영 상태로 남으므로 다음 주기 실행에서 자동 이월.
            logger.warning(
                "clawback 보류: 현재 기간 정산이 %s 상태 — 다음 주기로 이월 "
                "(beneficiary=%s type=%s delta=%s)",
                target.status, prior.organizer_id, prior.settlement_type, delta,
            )
            continue

        session.add(
            SettlementAdjustment(
                settlement_id=target.id,
                amount=-delta,
                adjustment_type="clawback",
                created_by=None,
                reason=(
                    f"클로백: 정산 {prior.id} "
                    f"({prior.period_start.date()}~{prior.period_end.date()}) "
                    f"확정 이후 발생한 환불·차지백 차감"
                ),
            )
        )
        target.net_payout = _dec(target.net_payout) - delta
        prior.refunds_clawed = _dec(prior.refunds_clawed) + delta
        clawed_count += 1
        clawed_total += delta
        logger.info(
            "clawback 적용: beneficiary=%s type=%s prior=%s delta=%s",
            prior.organizer_id, prior.settlement_type, prior.id, delta,
        )

    return clawed_count, clawed_total


@shared_task(
    name="app.tasks.settlement_generate.generate_settlements",
    bind=True,
    queue="celery",
    soft_time_limit=300,
    time_limit=330,
)
def generate_settlements(
    self, period_start_iso: str | None = None, period_end_iso: str | None = None
) -> dict:
    """기간별 organizer/재판매 판매자 정산 row 생성 + 이전 정산 클로백."""
    now = datetime.now(timezone.utc)
    if period_start_iso and period_end_iso:
        period_start = datetime.fromisoformat(period_start_iso)
        period_end = datetime.fromisoformat(period_end_iso)
    else:
        # 지난 캘린더월 [지난달 1일 00:00, 이번달 1일 00:00).
        # now 기반(30d)이면 재실행마다 period가 달라져 멱등(중복 skip)이 깨지므로 캘린더 경계로 고정.
        first_this = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        period_end = first_this
        period_start = (first_this - timedelta(days=1)).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )

    created = 0
    sellers_created = 0
    with SyncSession() as session:
        # 0. 동시 실행 직렬화 — 같은 기간을 처리하는 beat/수동/재시도가 겹치면
        #    둘 다 정산 row INSERT + 클로백 적용 → 이중 클로백. advisory xact lock 으로
        #    첫 실행 커밋까지 차단(이후 실행은 멱등 skip). sqlite 에선 no-op.
        _acquire_period_lock(session, period_start, period_end)

        # 멱등 기준 — 이미 존재하는 (beneficiary, type) 정산 맵
        existing_rows = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.period_start == period_start,
                OrganizerSettlement.period_end == period_end,
                OrganizerSettlement.deleted_at.is_(None),
            )
        ).scalars().all()
        current_by_key: dict[tuple[uuid.UUID, str], OrganizerSettlement] = {
            (s.organizer_id, s.settlement_type): s for s in existing_rows
        }

        # 1. 주최자 1차 판매 집계 — RESALE_BUY 제외 (블로커 #6)
        rows = session.execute(
            select(
                Event.organizer_id,
                func.coalesce(func.sum(Order.total_amount), 0),
                func.coalesce(func.sum(Order.platform_fee), 0),
                func.coalesce(func.sum(Order.pg_fee), 0),
            )
            .join(Event, Event.id == Order.event_id)
            .where(
                Order.order_type != OrderType.RESALE_BUY,
                Order.status.in_(_SETTLEABLE_STATUSES),
                Order.created_at >= period_start,
                Order.created_at < period_end,
                Order.deleted_at.is_(None),
            )
            .group_by(Event.organizer_id)
        ).all()
        primary_by_org: dict[uuid.UUID, tuple[Decimal, Decimal, Decimal]] = {
            org_id: (_dec(gross), _dec(platform_fee), _dec(pg_fee))
            for org_id, gross, platform_fee, pg_fee in rows
        }

        # 2. 재판매 분배 집계 (블로커 #6) — 판매자 수령액 / 주최자 로열티
        seller_gross: dict[uuid.UUID, Decimal] = {}
        royalty_by_org: dict[uuid.UUID, Decimal] = {}
        for order, organizer_id in _resale_orders(session, period_start, period_end):
            split = _resale_split(order)
            if not split:
                continue
            seller_gross[split["seller_id"]] = (
                seller_gross.get(split["seller_id"], Decimal("0")) + split["seller_receives"]
            )
            if split["artist_royalty"] > 0:
                royalty_by_org[organizer_id] = (
                    royalty_by_org.get(organizer_id, Decimal("0")) + split["artist_royalty"]
                )

        # 3. 주최자 정산 row 생성 (1차 판매 + 재판매 로열티)
        for org_id in set(primary_by_org) | set(royalty_by_org):
            key = (org_id, SettlementType.ORGANIZER.value)
            if key in current_by_key:
                continue  # 멱등: 같은 (organizer, period, type) skip
            gross, platform_fee, pg_fee = primary_by_org.get(
                org_id, (Decimal("0"), Decimal("0"), Decimal("0"))
            )
            refunds = _refund_equivalent(
                session, org_id, period_start, period_end, SettlementType.ORGANIZER.value
            )
            royalty = royalty_by_org.get(org_id, Decimal("0")).quantize(_CENT)
            net = gross - platform_fee - pg_fee - refunds + royalty
            settlement = OrganizerSettlement(
                organizer_id=org_id,
                settlement_type=SettlementType.ORGANIZER.value,
                period_start=period_start,
                period_end=period_end,
                gross_revenue=gross,
                total_refunds=refunds,
                platform_fee=platform_fee,
                pg_fee=pg_fee,
                net_payout=net,
                refunds_clawed=Decimal("0"),
                status=SettlementStatus.DRAFT.value,
            )
            settlement, is_new = _add_settlement_idempotent(session, settlement, key)
            current_by_key[key] = settlement
            if not is_new:
                # 동시 실행이 먼저 생성함 — 로열티 조정 중복 방지 위해 skip(멱등).
                continue
            if royalty > 0:
                session.add(
                    SettlementAdjustment(
                        settlement_id=settlement.id,
                        amount=royalty,
                        adjustment_type="resale_royalty",
                        created_by=None,
                        reason="재판매 아티스트 로열티 귀속 (resale premium 분배)",
                    )
                )
            created += 1

        # 4. 재판매 판매자 정산 row 생성 (블로커 #6 — seller_receives 귀속)
        for seller_id, gross in seller_gross.items():
            key = (seller_id, SettlementType.RESALE_SELLER.value)
            if key in current_by_key:
                continue
            refunds = _refund_equivalent(
                session, seller_id, period_start, period_end,
                SettlementType.RESALE_SELLER.value,
            )
            gross = gross.quantize(_CENT)
            settlement = OrganizerSettlement(
                organizer_id=seller_id,
                settlement_type=SettlementType.RESALE_SELLER.value,
                period_start=period_start,
                period_end=period_end,
                gross_revenue=gross,
                total_refunds=refunds,
                platform_fee=Decimal("0"),
                pg_fee=Decimal("0"),
                net_payout=gross - refunds,
                refunds_clawed=Decimal("0"),
                status=SettlementStatus.DRAFT.value,
            )
            settlement, is_new = _add_settlement_idempotent(session, settlement, key)
            current_by_key[key] = settlement
            if is_new:
                sellers_created += 1

        # 5. 클로백 (블로커 #4) — 이전 정산 이후 증가한 환불·차지백 차감
        clawed_count, clawed_total = _apply_clawbacks(
            session, period_start, period_end, current_by_key
        )

        session.commit()

    logger.info(
        "generate_settlements: created=%d sellers=%d clawbacks=%d clawed_total=%s period=%s~%s",
        created,
        sellers_created,
        clawed_count,
        clawed_total,
        period_start.isoformat(),
        period_end.isoformat(),
    )
    return {
        "created": created,
        "resale_seller_created": sellers_created,
        "clawbacks_applied": clawed_count,
        "clawback_total": float(clawed_total),
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
    }
