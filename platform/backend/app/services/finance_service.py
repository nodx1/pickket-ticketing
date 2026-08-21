"""Platform finance service — revenue aggregation for admin dashboard."""

import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from decimal import Decimal

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.models.event import Event
from app.models.fee_schedule import FeeSchedule
from app.models.order import Order, OrderStatus
from app.models.settlement import OrganizerSettlement, SettlementStatus
from app.models.user import User

logger = logging.getLogger(__name__)

_DEFAULT_PLATFORM_FEE_RATE = 0.05  # 5%
_DEFAULT_PG_FEE_RATE = 0.025  # 2.5% (PG 결제대행 수수료 기본 — FeeSchedule.pg_fee_rate default와 일치)
# 매출 모집단 — settlement_generate._SETTLEABLE_STATUSES 와 동일.
# 환불된 주문도 gross/fee 에는 포함하고(전이 폐쇄집합·수수료 보존), 실제 환불액은
# order.total_refunded 로 차감한다. PARTIALLY_REFUNDED 누락과 전액환불 이중차감을
# 동시에 닫는다 (M-3).
_PAID_STATUSES = (
    OrderStatus.PAID,
    OrderStatus.CONFIRMED,
    OrderStatus.PARTIALLY_REFUNDED,
    OrderStatus.REFUNDED,
)


class FinanceError(Exception):
    """정산 처리 오류."""


class FinanceService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def _provider_order_by(pg_provider: "str | None"):
        """provider-aware fee_schedule 선택 정렬(dev_v3 계약 (3)).

        같은 event/organizer effective 구간에서:
          1) provider 매치행(pg_provider = :provider) 최우선,
          2) 없으면 NULL 기본행(pg_provider IS NULL) 폴백,
          3) 그 안에서 created_at DESC(최신).
        ``ORDER BY (pg_provider = :provider) DESC NULLS LAST,
                   (pg_provider IS NULL) DESC, created_at DESC``.

        pg_provider 미지정/미매치(None) 이면 1항은 무효(전부 False/NULL)라 2항이
        지배 → **NULL 기본행 우선**. 이렇게 해야 portone/stripe 등 오버라이드가 없는
        provider 주문이 실수로 타 provider 전용행(toss/nicepay)의 pg_fee 를 물려받지
        않는다. 기존 데이터는 전부 pg_provider NULL 이라 사실상 created_at DESC(하위호환).
        """
        base_pref = FeeSchedule.pg_provider.is_(None)
        if pg_provider:
            match_rank = (FeeSchedule.pg_provider == pg_provider)
            return (
                match_rank.desc().nullslast(),
                base_pref.desc(),
                FeeSchedule.created_at.desc(),
            )
        return (base_pref.desc(), FeeSchedule.created_at.desc())

    async def _resolve_fee_schedule(
        self,
        event_id: "uuid.UUID | None" = None,
        organizer_id: "uuid.UUID | None" = None,
        pg_provider: "str | None" = None,
    ) -> "FeeSchedule | None":
        """수수료 스케줄 조회 — 이벤트 → 주최자 → 플랫폼 기본 순서. 없으면 None.

        pg_provider 지정 시 각 스코프 내에서 provider 매치행을 우선(없으면 NULL
        기본행 폴백)한다 — dev_v3 계약 (3). platform_fee_rate 는 스코프 내 동일하고
        pg_fee_rate/pg_fee_fixed 만 provider별이므로, 선택된 행에서 전 필드를 읽어도
        정합이 유지된다.
        """
        now = datetime.now(timezone.utc)
        provider_order = self._provider_order_by(pg_provider)

        if event_id:
            result = await self.session.execute(
                select(FeeSchedule)
                .where(
                    FeeSchedule.event_id == event_id,
                    FeeSchedule.effective_from <= now,
                    (FeeSchedule.effective_until.is_(None)) | (FeeSchedule.effective_until > now),
                )
                .order_by(*provider_order)
                .limit(1)
            )
            fee = result.scalar_one_or_none()
            if fee:
                return fee

        if organizer_id:
            result = await self.session.execute(
                select(FeeSchedule)
                .where(
                    FeeSchedule.organizer_id == organizer_id,
                    FeeSchedule.event_id.is_(None),
                    FeeSchedule.effective_from <= now,
                    (FeeSchedule.effective_until.is_(None)) | (FeeSchedule.effective_until > now),
                )
                .order_by(*provider_order)
                .limit(1)
            )
            fee = result.scalar_one_or_none()
            if fee:
                return fee

        result = await self.session.execute(
            select(FeeSchedule)
            .where(
                FeeSchedule.organizer_id.is_(None),
                FeeSchedule.event_id.is_(None),
                FeeSchedule.effective_from <= now,
                (FeeSchedule.effective_until.is_(None)) | (FeeSchedule.effective_until > now),
            )
            .order_by(*provider_order)
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_fee_rates(
        self,
        event_id: "uuid.UUID | None" = None,
        organizer_id: "uuid.UUID | None" = None,
    ) -> tuple[float, float]:
        """(platform_fee_rate, pg_fee_rate) 조회 — 이벤트 → 주최자 → 플랫폼 기본 순서.

        정산 fee 동결(4d-1/4d-2)의 단일 출처. 둘 다 같은 FeeSchedule row에서 가져와
        platform/pg가 서로 다른 스케줄을 참조하는 불일치를 방지한다.
        """
        fee = await self._resolve_fee_schedule(event_id, organizer_id)
        if fee:
            return float(fee.platform_fee_rate), float(fee.pg_fee_rate)
        return _DEFAULT_PLATFORM_FEE_RATE, _DEFAULT_PG_FEE_RATE

    async def get_fee_rate(
        self,
        event_id: "uuid.UUID | None" = None,
        organizer_id: "uuid.UUID | None" = None,
    ) -> float:
        """platform 수수료율만 조회 — 기존 호출부 하위호환 wrapper."""
        platform_rate, _ = await self.get_fee_rates(event_id, organizer_id)
        return platform_rate

    async def get_fee_components(
        self,
        event_id: "uuid.UUID | None" = None,
        organizer_id: "uuid.UUID | None" = None,
        pg_provider: "str | None" = None,
    ) -> dict:
        """SPEC §2.7 — fee_type 포함 정률+정액 fee 컴포넌트 조회.

        이벤트 → 주최자 → 플랫폼 기본 순서(get_fee_rates 와 동일 해석).
        go fee-plan write 가 FeeSchedule 에 정액(fixed)을 미러하면 여기서 노출되어
        동결(payment_service)이 정률+정액으로 청구 → 청구=정산 정합.

        pg_provider 지정 시 provider 전용 pg_fee 오버라이드행을 우선 선택한다(없으면
        NULL 기본행 폴백) — dev_v3 계약 (3). 하위호환: 미지정이면 기존 동작.
        """
        fee = await self._resolve_fee_schedule(event_id, organizer_id, pg_provider)
        if fee:
            return {
                "fee_type": getattr(fee, "fee_type", "percentage") or "percentage",
                "platform_fee_rate": float(fee.platform_fee_rate),
                "platform_fee_fixed": float(getattr(fee, "platform_fee_fixed", 0) or 0),
                "pg_fee_rate": float(fee.pg_fee_rate),
                "pg_fee_fixed": float(getattr(fee, "pg_fee_fixed", 0) or 0),
            }
        return {
            "fee_type": "percentage",
            "platform_fee_rate": _DEFAULT_PLATFORM_FEE_RATE,
            "platform_fee_fixed": 0.0,
            "pg_fee_rate": _DEFAULT_PG_FEE_RATE,
            "pg_fee_fixed": 0.0,
        }

    async def _frozen_or_estimated_platform_fee(
        self, order: Order, event: Event, fee_cache: dict
    ) -> float:
        """동결값(order.platform_fee) 우선 — 정액 포함 절대금액.

        동결 전(NULL) 주문만 요율 재계산으로 fallback. 단 fallback 도 정액(fixed)을
        반영하도록 compute_fees 사용(이전엔 get_fee_rate 로 정률만 → 정산 SUM 과 불일치).
        """
        if order.platform_fee is not None:
            return float(order.platform_fee)
        cache_key = (str(order.event_id), str(event.organizer_id))
        if cache_key not in fee_cache:
            fee_cache[cache_key] = await self.get_fee_components(
                order.event_id, event.organizer_id
            )
        plat, _pg = self.compute_fees(order.total_amount, fee_cache[cache_key])
        return float(plat)

    async def _frozen_or_estimated_pg_fee(
        self, order: Order, event: Event, fee_cache: dict
    ) -> float:
        """PG 결제대행 수수료 — 동결값(order.pg_fee) 우선, NULL 이면 요율 재계산.

        net_settlement 가 PG 수수료를 차감하지 않아 settlements 화면(net_payout,
        PG 수수료 포함 차감)과 불일치했다(P2-C5). 정산 생성 로직과 동일 기준으로 차감한다.
        """
        if order.pg_fee is not None:
            return float(order.pg_fee)
        cache_key = (str(order.event_id), str(event.organizer_id))
        if cache_key not in fee_cache:
            fee_cache[cache_key] = await self.get_fee_components(
                order.event_id, event.organizer_id
            )
        _plat, pg = self.compute_fees(order.total_amount, fee_cache[cache_key])
        return float(pg)

    @staticmethod
    def compute_fees(total, components: dict) -> "tuple[Decimal, Decimal]":
        """(platform_fee, pg_fee) 절대금액 산정 — fee_type 분기.

        반환값은 정액 포함 절대금액(Decimal). 동결 시 order.platform_fee 에 그대로
        저장 → 정산 SUM 이 정액까지 포착(SPEC §2.7).
        """
        t = Decimal(str(total or 0))
        ftype = components.get("fee_type", "percentage")
        p_rate = Decimal(str(components.get("platform_fee_rate", 0)))
        p_fixed = Decimal(str(components.get("platform_fee_fixed", 0)))
        g_rate = Decimal(str(components.get("pg_fee_rate", 0)))
        g_fixed = Decimal(str(components.get("pg_fee_fixed", 0)))
        if ftype == "fixed":
            return p_fixed, g_fixed
        if ftype == "percentage_plus_fixed":
            return t * p_rate + p_fixed, t * g_rate + g_fixed
        # percentage (기본)
        return t * p_rate, t * g_rate

    @staticmethod
    def _order_paid_at(order: Order) -> datetime:
        return order.captured_at or order.pg_approved_at or order.created_at

    async def _load_paid_orders(
        self,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> list[tuple[Order, Event]]:
        paid_at = func.coalesce(Order.captured_at, Order.pg_approved_at, Order.created_at)
        query = (
            select(Order, Event)
            .join(Event, Event.id == Order.event_id)
            .where(Order.status.in_(_PAID_STATUSES))
        )
        if date_from:
            query = query.where(paid_at >= date_from)
        if date_to:
            query = query.where(paid_at <= date_to)

        result = await self.session.execute(query)
        return list(result.all())

    async def review_settlement(
        self,
        settlement_id: "uuid.UUID",
        *,
        reviewer_id: "uuid.UUID",
    ) -> OrganizerSettlement:
        """finance_admin이 정산서 검토 승인."""
        result = await self.session.execute(
            select(OrganizerSettlement).where(OrganizerSettlement.id == settlement_id).with_for_update()
        )
        settlement = result.scalar_one_or_none()
        if not settlement:
            raise FinanceError("Settlement not found")
        reviewable = {SettlementStatus.DRAFT, SettlementStatus.PENDING_REVIEW,
                      SettlementStatus.DRAFT.value, SettlementStatus.PENDING_REVIEW.value}
        if settlement.status not in reviewable:
            raise FinanceError("Only draft/pending_review settlements can be reviewed")

        settlement.status = SettlementStatus.REVIEWED
        settlement.reviewed_by = reviewer_id
        settlement.reviewed_at = datetime.now(timezone.utc)

        await write_audit_log(
            self.session,
            actor_id=reviewer_id,
            action="settlement.reviewed",
            resource_type="settlement",
            resource_id=str(settlement_id),
            new_value={"net_payout": float(settlement.net_payout)},
        )
        return settlement

    async def approve_settlement(
        self,
        settlement_id: "uuid.UUID",
        *,
        approver_id: "uuid.UUID",
    ) -> OrganizerSettlement:
        """super_admin이 정산서 최종 승인. 검토자와 다른 사람이어야 한다."""
        result = await self.session.execute(
            select(OrganizerSettlement).where(OrganizerSettlement.id == settlement_id).with_for_update()
        )
        settlement = result.scalar_one_or_none()
        if not settlement:
            raise FinanceError("Settlement not found")
        if settlement.status != SettlementStatus.REVIEWED:
            raise FinanceError("Only reviewed settlements can be approved")
        if settlement.reviewed_by == approver_id:
            raise FinanceError("Reviewer and approver must be different")

        settlement.status = SettlementStatus.APPROVED
        settlement.approved_by = approver_id
        settlement.approved_at = datetime.now(timezone.utc)

        await write_audit_log(
            self.session,
            actor_id=approver_id,
            action="settlement.approved",
            resource_type="settlement",
            resource_id=str(settlement_id),
            new_value={"net_payout": float(settlement.net_payout)},
        )
        return settlement

    async def get_summary(
        self,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        period: str | None = None,
    ) -> dict:
        paid_rows = await self._load_paid_orders(date_from, date_to)

        gross_revenue = Decimal("0")
        platform_fees = Decimal("0")
        pg_fees = Decimal("0")
        total_refunds = Decimal("0")
        refund_count = 0
        fee_cache: dict[tuple[str, str], dict] = {}

        for order, event in paid_rows:
            gross_revenue += Decimal(str(order.total_amount or 0))
            platform_fees += Decimal(
                str(await self._frozen_or_estimated_platform_fee(order, event, fee_cache))
            )
            pg_fees += Decimal(
                str(await self._frozen_or_estimated_pg_fee(order, event, fee_cache))
            )
            refunded = Decimal(str(order.total_refunded or 0))
            if refunded > 0:
                total_refunds += refunded
                refund_count += 1

        order_count = len(paid_rows)

        result = {
            "gross_revenue": float(round(gross_revenue, 2)),
            "platform_fees": float(round(platform_fees, 2)),
            "pg_fees": float(round(pg_fees, 2)),
            "total_refunds": float(round(total_refunds, 2)),
            # net_settlement 은 정산(net_payout)과 동일하게 PG 수수료까지 차감 (P2-C5)
            "net_settlement": float(
                round(gross_revenue - platform_fees - pg_fees - total_refunds, 2)
            ),
            "order_count": order_count,
            "refund_count": refund_count,
            "daily_revenue": None,
        }

        if period:
            days = {"7d": 7, "30d": 30, "90d": 90}.get(period, 30)
            start = datetime.now(timezone.utc) - timedelta(days=days)
            daily_rows = await self._load_paid_orders(start, datetime.now(timezone.utc))
            daily_revenue: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
            for order, _event in daily_rows:
                day = str(self._order_paid_at(order).date())
                daily_revenue[day] += Decimal(str(order.total_amount or 0))
            result["daily_revenue"] = [
                {"date": day, "amount": float(round(amount, 2))}
                for day, amount in sorted(daily_revenue.items())
            ]

        return result

    async def get_by_event(
        self,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        skip: int = 0,
        limit: int = 50,
        sort: str | None = None,
    ) -> tuple[list[dict], int]:
        paid_rows = await self._load_paid_orders(date_from, date_to)
        fee_cache: dict[tuple[str, str], dict] = {}
        event_map: dict[str, dict] = {}

        for order, event in paid_rows:
            key = str(event.id)
            fee = await self._frozen_or_estimated_platform_fee(order, event, fee_cache)
            pg = await self._frozen_or_estimated_pg_fee(order, event, fee_cache)

            item = event_map.setdefault(
                key,
                {
                    "event_id": event.id,
                    "event_title": event.title,
                    "category": event.category,
                    "organizer_id": event.organizer_id,
                    "gross_revenue": Decimal("0"),
                    "platform_fee": Decimal("0"),
                    "pg_fee": Decimal("0"),
                    "refund_total": Decimal("0"),
                    "ticket_count": 0,
                },
            )
            item["gross_revenue"] += Decimal(str(order.total_amount or 0))
            item["platform_fee"] += Decimal(str(fee))
            item["pg_fee"] += Decimal(str(pg))
            item["refund_total"] += Decimal(str(order.total_refunded or 0))
            item["ticket_count"] += int(order.quantity)

        events = []
        for item in event_map.values():
            gross = item["gross_revenue"]
            fee = item["platform_fee"]
            pg = item["pg_fee"]
            refund = item["refund_total"]
            events.append(
                {
                    **item,
                    "gross_revenue": float(round(gross, 2)),
                    "platform_fee": float(round(fee, 2)),
                    "pg_fee": float(round(pg, 2)),
                    "refund_total": float(round(refund, 2)),
                    # 정산(net_payout)과 동일하게 PG 수수료까지 차감 (P2 Major)
                    "net_settlement": float(round(gross - fee - pg - refund, 2)),
                }
            )

        total = len(events)
        reverse = sort != "revenue_asc"
        events.sort(key=lambda item: item["gross_revenue"], reverse=reverse)
        return events[skip : skip + limit], total

    async def get_by_organizer(
        self,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict], int]:
        paid_at = func.coalesce(Order.captured_at, Order.pg_approved_at, Order.created_at)
        paid_query = (
            select(Order, Event, User)
            .join(Event, Event.id == Order.event_id)
            .join(User, User.id == Event.organizer_id)
            .where(Order.status.in_(_PAID_STATUSES))
        )
        if date_from:
            paid_query = paid_query.where(paid_at >= date_from)
        if date_to:
            paid_query = paid_query.where(paid_at <= date_to)
        paid_rows = (await self.session.execute(paid_query)).all()

        fee_cache: dict[tuple[str, str], dict] = {}
        organizer_map: dict[str, dict] = {}

        for order, event, organizer in paid_rows:
            key = str(event.organizer_id)
            fee = await self._frozen_or_estimated_platform_fee(order, event, fee_cache)
            pg = await self._frozen_or_estimated_pg_fee(order, event, fee_cache)

            item = organizer_map.setdefault(
                key,
                {
                    "organizer_id": event.organizer_id,
                    "organizer_name": organizer.name,
                    "organizer_email": organizer.email,
                    "event_ids": set(),
                    "gross_revenue": Decimal("0"),
                    "platform_fee": Decimal("0"),
                    "pg_fee": Decimal("0"),
                    "refund_total": Decimal("0"),
                },
            )
            item["event_ids"].add(str(event.id))
            item["gross_revenue"] += Decimal(str(order.total_amount or 0))
            item["platform_fee"] += Decimal(str(fee))
            item["pg_fee"] += Decimal(str(pg))
            item["refund_total"] += Decimal(str(order.total_refunded or 0))

        organizers = []
        for item in organizer_map.values():
            gross = item["gross_revenue"]
            fee = item["platform_fee"]
            pg = item["pg_fee"]
            refund = item["refund_total"]
            organizers.append(
                {
                    "organizer_id": item["organizer_id"],
                    "organizer_name": item["organizer_name"],
                    "organizer_email": item["organizer_email"],
                    "event_count": len(item["event_ids"]),
                    "gross_revenue": float(round(gross, 2)),
                    "platform_fee": float(round(fee, 2)),
                    "pg_fee": float(round(pg, 2)),
                    "net_settlement": float(round(gross - fee - pg - refund, 2)),
                }
            )

        organizers.sort(key=lambda item: item["gross_revenue"], reverse=True)
        total = len(organizers)
        return organizers[skip : skip + limit], total
