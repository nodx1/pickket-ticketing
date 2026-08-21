"""
Check-in Service
================
Handles ticket check-in via QR scan, attendance tracking, and no-show processing.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance import Attendance
from app.models.event_admission import EventAdmission
from app.models.order import Order, OrderStatus, OrderType
from app.models.event import Event
from app.models.seat import Seat
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.models.point import PointType, PointTransactionType
from app.models.event import SeatTier
from app.schemas.checkin_ops import (
    CheckinAttendeeItem,
    NoShowHistoryItem,
    NoShowHistoryResponse,
)
from app.schemas.attendance import AttendanceStats, NoShowProcessResult
from app.services.admission_service import AdmissionError, admit
from app.services.fair_booking_service import FairBookingService
from app.services.point_service import PointService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Predictive No-Show Detector
# ---------------------------------------------------------------------------


class PredictiveNoShowDetector:
    """연합학습 기반 노쇼 예측 — 가중합 로지스틱 모델.

    Predicts no-show probability using a federated learning-inspired approach:
    - Features are computed locally (on-device concept)
    - Only model weights are shared with the server
    - Individual user data is never directly exposed

    Features:
    1. booking_lead_days: Days between booking and event
    2. historical_noshow_rate: User's past no-show ratio
    3. point_balance_normalized: Normalized point balance (proxy for engagement)
    4. has_deposit: Whether a deposit was placed (binary)
    5. day_of_week_score: Weekend events have higher no-show rates

    Risk = sigmoid(Σ w_k × feature_k + bias)
    """

    # Pre-trained weights (would be updated via federated averaging in production)
    WEIGHTS = {
        "booking_lead_days": -0.02,  # Longer lead → slightly lower risk
        "historical_noshow_rate": 2.5,  # Strong predictor
        "point_balance_normalized": -0.8,  # Higher balance → lower risk
        "has_deposit": -1.2,  # Deposit → much lower risk
        "day_of_week_score": 0.3,  # Weekend → higher risk
    }
    BIAS = -0.5
    ALERT_THRESHOLD = 0.7

    @staticmethod
    def _sigmoid(x: float) -> float:
        """Numerically stable sigmoid function."""
        import math

        if x >= 0:
            return 1.0 / (1.0 + math.exp(-x))
        else:
            exp_x = math.exp(x)
            return exp_x / (1.0 + exp_x)

    @staticmethod
    def compute_risk(
        booking_lead_days: float = 7.0,
        historical_noshow_rate: float = 0.0,
        point_balance: float = 100.0,
        has_deposit: bool = False,
        event_day_of_week: int = 0,  # 0=Monday, 6=Sunday
    ) -> dict:
        """Compute no-show risk score for a reservation.

        Returns:
            Dict with 'risk_score' [0,1], 'alert' bool, and feature breakdown.
        """
        # Normalize features
        features = {
            "booking_lead_days": min(booking_lead_days, 90.0) / 90.0 * 10,
            "historical_noshow_rate": historical_noshow_rate,
            "point_balance_normalized": min(point_balance, 1000.0) / 1000.0,
            "has_deposit": 1.0 if has_deposit else 0.0,
            "day_of_week_score": 1.0 if event_day_of_week >= 5 else 0.0,
        }

        # Weighted sum
        z = PredictiveNoShowDetector.BIAS
        for key, weight in PredictiveNoShowDetector.WEIGHTS.items():
            z += weight * features.get(key, 0.0)

        risk_score = PredictiveNoShowDetector._sigmoid(z)

        return {
            "risk_score": round(risk_score, 4),
            "alert": risk_score > PredictiveNoShowDetector.ALERT_THRESHOLD,
            "features": features,
            "model_version": "federated_v1",
        }

    @staticmethod
    def aggregate_federated_weights(
        local_weights: list[dict[str, float]],
        sample_counts: list[int],
    ) -> dict[str, float]:
        """Federated averaging of model weights from multiple local updates.

        Simulates the federated learning aggregation step where
        local model updates are combined without sharing raw data.

        Args:
            local_weights: List of weight dicts from local training.
            sample_counts: Number of samples used for each local update.

        Returns:
            Aggregated global weights.
        """
        total_samples = sum(sample_counts)
        if total_samples == 0:
            return PredictiveNoShowDetector.WEIGHTS.copy()

        aggregated = {}
        for key in PredictiveNoShowDetector.WEIGHTS:
            weighted_sum = sum(w.get(key, 0.0) * n for w, n in zip(local_weights, sample_counts))
            aggregated[key] = weighted_sum / total_samples

        return aggregated


class CheckInService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def check_in(
        self,
        event_id: uuid.UUID,
        ticket_id: uuid.UUID,
        scanner_user_id: uuid.UUID | None = None,
        method: str = "qr_scan",
    ) -> tuple[Attendance, bool]:
        """티켓 체크인 (F1: 멱등·부작용 SoT = admit()/event_admissions).

        하위호환을 위해 `Attendance` 행(표시/집계 호환)도 최초 입장 시 1건 생성하지만,
        멱등 판정과 부작용(포인트·NFT·보증금)은 admit() 이 event_admissions 기준으로 일원화한다.
        allpass 다일 입장에선 2일차부터 Attendance 행을 추가로 만들지 않는다(ticket_id UNIQUE).
        """
        # Get ticket
        result = await self.session.execute(
            select(Ticket).where(Ticket.id == ticket_id, Ticket.event_id == event_id)
        )
        ticket = result.scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found for this event")

        event = (
            await self.session.execute(select(Event).where(Event.id == event_id))
        ).scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        # F1: 입장 판정을 admit() 에 위임 (멱등 SoT = event_admissions, 부작용 최초 1회).
        try:
            admit_result = await admit(
                self.session,
                ticket,
                event,
                datetime.now(timezone.utc),
                checked_in_by=scanner_user_id,
                method=method,
            )
        except AdmissionError as e:
            if e.code == "NOT_ADMITTABLE":
                raise ValueError("체크인할 수 없는 티켓입니다 (취소/만료)")
            raise ValueError(e.message)

        if admit_result.already:
            raise ValueError("Already checked in")

        # 표시/호환 Attendance 행 — 최초 입장에만 1건(ticket_id UNIQUE). 이미 있으면 재사용.
        attendance = (
            await self.session.execute(
                select(Attendance).where(Attendance.ticket_id == ticket_id)
            )
        ).scalar_one_or_none()
        if attendance is None:
            attendance = Attendance(
                ticket_id=ticket_id,
                event_id=event_id,
                user_id=ticket.current_owner_id,
                checked_in_at=admit_result.admission.checked_in_at,
                checked_in_by=scanner_user_id,
                method=method,
            )
            self.session.add(attendance)
            await self.session.flush()

        return attendance, admit_result.deposit_refunded

    async def get_stats(self, event_id: uuid.UUID) -> AttendanceStats:
        # Total tickets for event
        total_result = await self.session.execute(
            select(func.count(Ticket.id)).where(
                Ticket.event_id == event_id,
                Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED, TicketStatus.PENDING]),
            )
        )
        total_tickets = total_result.scalar() or 0

        # F1: 입장 인원 = event_admissions 의 distinct 티켓 수(이중집계 방지).
        # allpass 다일 이벤트에서 같은 티켓이 여러 날 입장해도 "입장 인원" 은 1로 집계.
        checkin_result = await self.session.execute(
            select(func.count(func.distinct(EventAdmission.ticket_id))).where(
                EventAdmission.event_id == event_id
            )
        )
        checked_in = checkin_result.scalar() or 0

        cancelled_result = await self.session.execute(
            select(func.count(Ticket.id)).where(
                Ticket.event_id == event_id,
                Ticket.status == TicketStatus.CANCELLED,
            )
        )
        cancelled = cancelled_result.scalar() or 0

        no_show_result = await self.session.execute(
            select(func.count(Order.id)).where(
                Order.event_id == event_id,
                Order.order_type == OrderType.DEPOSIT,
                Order.status == OrderStatus.DEPOSIT_FORFEITED,
            )
        )
        no_show = no_show_result.scalar() or 0

        # F1: 미입장(=입장 원장 없는) ACTIVE 티켓의 매출 영향. event_admissions 기준.
        unchecked_loss_result = await self.session.execute(
            select(func.sum(Ticket.purchase_price)).where(
                Ticket.event_id == event_id,
                Ticket.status == TicketStatus.ACTIVE,
                Ticket.id.not_in(
                    select(EventAdmission.ticket_id).where(EventAdmission.event_id == event_id)
                ),
            )
        )
        revenue_impact = float(unchecked_loss_result.scalar() or 0.0)

        # Hourly breakdown — F1: 입장 원장(event_admissions) 기준.
        hourly_result = await self.session.execute(
            select(
                func.date_trunc("hour", EventAdmission.checked_in_at).label("hour"),
                func.count(EventAdmission.id).label("count"),
            )
            .where(EventAdmission.event_id == event_id)
            .group_by("hour")
            .order_by("hour")
        )
        hourly = [{"hour": str(row.hour), "count": row.count} for row in hourly_result.all()]

        return AttendanceStats(
            event_id=event_id,
            total_tickets=total_tickets,
            checked_in=checked_in,
            not_checked_in=total_tickets - checked_in,
            attendance_rate=round(checked_in / total_tickets * 100, 1)
            if total_tickets > 0
            else 0.0,
            no_show=no_show,
            cancelled=cancelled,
            revenue_impact=revenue_impact,
            hourly_breakdown=hourly,
        )

    async def list_attendees(
        self,
        event_id: uuid.UUID,
        *,
        q: str | None = None,
        status: str | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[CheckinAttendeeItem], int]:
        result = await self.session.execute(
            select(Ticket, User, SeatTier, Seat, Attendance, Order)
            .join(User, Ticket.current_owner_id == User.id)
            .join(SeatTier, Ticket.tier_id == SeatTier.id)
            .outerjoin(Seat, Ticket.seat_id == Seat.id)
            .outerjoin(Attendance, Attendance.ticket_id == Ticket.id)
            .outerjoin(
                Order,
                and_(
                    Order.event_id == Ticket.event_id,
                    Order.user_id == Ticket.current_owner_id,
                    Order.order_type == OrderType.DEPOSIT,
                ),
            )
            .where(
                Ticket.event_id == event_id,
                Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED, TicketStatus.PENDING]),
            )
        )

        rows = result.all()
        normalized_q = (q or "").strip().lower()
        attendees: list[CheckinAttendeeItem] = []

        for ticket, user, tier, seat, attendance, deposit_order in rows:
            attendee_status = "active"
            if attendance or ticket.status == TicketStatus.USED:
                attendee_status = "checked_in"
            elif ticket.status == TicketStatus.PENDING:
                attendee_status = "pending_payment"
            elif deposit_order and deposit_order.status == OrderStatus.DEPOSIT_FORFEITED:
                attendee_status = "no_show"

            seat_label = None
            if seat:
                seat_label = seat.label or f"{seat.section} {seat.row_number}열 {seat.seat_number}번"

            item = CheckinAttendeeItem(
                ticket_id=ticket.id,
                user_id=user.id,
                name=user.name,
                phone=user.phone,
                tier=tier.name if tier else None,
                seat=seat_label,
                status=attendee_status,
                checked_in_at=attendance.checked_in_at if attendance else None,
            )

            if normalized_q:
                haystack = " ".join(
                    filter(
                        None,
                        [
                            item.name.lower(),
                            (item.phone or "").lower(),
                            str(item.ticket_id).lower(),
                        ],
                    )
                )
                if normalized_q not in haystack:
                    continue

            if status and item.status != status:
                continue

            attendees.append(item)

        attendees.sort(
            key=lambda entry: (
                entry.checked_in_at is None,
                entry.checked_in_at or datetime.max.replace(tzinfo=timezone.utc),
                entry.name,
            )
        )
        total = len(attendees)
        return attendees[skip : skip + limit], total

    async def get_noshow_history(self, user_id: uuid.UUID) -> NoShowHistoryResponse:
        rows = (
            await self.session.execute(
                select(Order, Event)
                .join(Event, Event.id == Order.event_id)
                .where(
                    Order.user_id == user_id,
                    Order.order_type == OrderType.DEPOSIT,
                    Order.status == OrderStatus.DEPOSIT_FORFEITED,
                )
                .order_by(Order.updated_at.desc(), Order.created_at.desc())
            )
        ).all()

        penalty = await self.check_noshow_penalty(user_id)
        history = [
            NoShowHistoryItem(
                event_id=event.id,
                event_title=event.title,
                event_date=event.event_date,
                order_id=order.id,
                recorded_at=order.updated_at or order.created_at,
                penalty_level=penalty["penalty_level"],
            )
            for order, event in rows
        ]
        return NoShowHistoryResponse(
            user_id=user_id,
            total_no_shows=len(history),
            restricted_until=penalty["restricted_until"],
            history=history,
        )

    async def check_noshow_penalty(self, user_id: uuid.UUID) -> dict:
        rows = (
            await self.session.execute(
                select(Order)
                .where(
                    Order.user_id == user_id,
                    Order.order_type == OrderType.DEPOSIT,
                    Order.status == OrderStatus.DEPOSIT_FORFEITED,
                )
                .order_by(Order.updated_at.desc(), Order.created_at.desc())
            )
        ).scalars().all()

        total_no_shows = len(rows)
        if total_no_shows <= 1:
            return {
                "total_no_shows": total_no_shows,
                "penalty_level": "warning" if total_no_shows == 1 else "none",
                "restricted_until": None,
                "is_restricted": False,
            }

        latest = rows[0].updated_at or rows[0].created_at
        if total_no_shows == 2:
            restricted_until = latest + timedelta(days=7)
            penalty_level = "temporary_ban_7d"
        else:
            restricted_until = latest + timedelta(days=30)
            penalty_level = "temporary_ban_30d"

        return {
            "total_no_shows": total_no_shows,
            "penalty_level": penalty_level,
            "restricted_until": restricted_until,
            "is_restricted": restricted_until > datetime.now(timezone.utc),
        }

    async def process_no_shows(self, event_id: uuid.UUID) -> NoShowProcessResult:
        """Process no-shows: forfeit deposits for users who didn't check in."""
        # Get event
        event_result = await self.session.execute(select(Event).where(Event.id == event_id))
        event = event_result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        # Find all deposit orders that are still held (not refunded = no-show)
        deposits_result = await self.session.execute(
            select(Order).where(
                Order.event_id == event_id,
                Order.order_type == OrderType.DEPOSIT,
                Order.status == OrderStatus.DEPOSIT_HELD,
            )
        )
        held_deposits = list(deposits_result.scalars().all())

        total_forfeited = 0.0
        point_service = PointService(self.session)
        for deposit in held_deposits:
            deposit.status = OrderStatus.DEPOSIT_FORFEITED
            total_forfeited += deposit.total_amount

            user = (
                await self.session.execute(select(User).where(User.id == deposit.user_id))
            ).scalar_one_or_none()
            if user:
                user.no_show_rate = min(1.0, float(user.no_show_rate or 0.0) + 0.1)

            # Deduct points for no-show (20 Fan + 20 Social)
            for pt in [PointType.FAN, PointType.SOCIAL]:
                try:
                    await point_service.deduct(
                        user_id=deposit.user_id,
                        point_type=pt,
                        amount=20,
                        tx_type=PointTransactionType.DEDUCT_NOSHOW,
                        reference_id=event_id,
                        description="노쇼 포인트 차감",
                        # Penalty: take whatever the user has, flooring at 0.
                        allow_overdraft=True,
                    )
                except Exception:
                    logger.warning(
                        "Failed to deduct no-show points for user %s",
                        deposit.user_id,
                        exc_info=True,
                    )

        fair_booking_service = FairBookingService(self.session)
        try:
            await fair_booking_service.auto_assign_waitlist(event_id)
        except Exception:
            logger.warning("Failed to auto-assign waitlist for event %s", event_id, exc_info=True)

        await self.session.flush()

        return NoShowProcessResult(
            event_id=event_id,
            total_no_shows=len(held_deposits),
            deposits_forfeited=len(held_deposits),
            total_forfeited_amount=total_forfeited,
        )
