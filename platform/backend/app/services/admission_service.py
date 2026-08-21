"""
Admission Service (F1 — 다일 입장)
==================================
CHECKIN-STATE-CONTRACT-F1 §3.3 의 공통 입장 판정 함수 `admit()`.

설계 원칙 (계약서 §2):
- "입장(admission)" 과 "티켓 소진(status)" 을 분리한다. 다일에선 1티켓이 여러 번 입장.
- 입장 멱등 SoT = `event_admissions` per-day 원장 1개. (ticket.checked_in_at 스칼라,
  attendances 행은 표시/호환용 — 멱등 판정에서 배제.)
- 부작용(포인트·NFT·보증금)은 **최초 입장 1회** 만.
- KST 로컬 날짜로 유효일·원장키 판정 (UTC ::date 캐스트 금지 — 06시 게이트 전날버그).

멱등·동시성 증명:
- "동시 2게이트?": `event_admissions (ticket_id, attended_date)` UNIQUE INSERT 를
  SAVEPOINT(begin_nested) 안에서 시도한다. 패자는 IntegrityError → already 로 처리하고
  바깥 트랜잭션은 살아있다. 같은 티켓·같은 날 원장은 정확히 1행만 존재.
- "부작용 후 crash?": 부작용(포인트·NFT·보증금)은 전부 같은 DB 트랜잭션 내 write 이므로
  COMMIT 전이면 원장 INSERT 와 함께 원자적으로 롤백된다. first_checked_in_at 세팅도 동일 txn.
  외부호출(go 웹훅)은 go 쪽에서 COMMIT 후 수행 → v2 admit 은 순수 DB 경계.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.event_admission import EventAdmission
from app.models.order import Order, OrderStatus, OrderType
from app.models.point import PointType, PointTransactionType
from app.models.ticket import Ticket, TicketStatus

logger = logging.getLogger(__name__)

KST = ZoneInfo("Asia/Seoul")


class AdmissionError(Exception):
    """입장 거부. `code` 로 호출측이 상태코드/메시지를 매핑한다."""

    def __init__(self, code: str, message: str):
        self.code = code  # NOT_ADMITTABLE | NOT_ADMISSION_DAY
        self.message = message
        super().__init__(message)


@dataclass
class AdmitResult:
    admission: EventAdmission
    already: bool  # 오늘 이미 입장(멱등)
    first_admission: bool  # 이번 호출이 이 티켓의 최초 입장인지
    attended_date: date
    deposit_refunded: bool = False

    @property
    def outcome(self) -> str:
        """게이트 UI 신호 (cross-request 계약, §13 당일 재입장).

        - `admitted`: 오늘 최초 입장(정상 통과, 초록).
        - `reentry_ok`: 오늘 이미 입장한 티켓의 당일 재스캔(점심·주차 반복출입 = 정상, 초록).
          allpass/daypass/single 무관 — '오늘 이미 들어왔다'는 곧 재입장 허용이다. 차단이 아님.
        실제 차단(single/daypass 소진·타일·취소/만료)은 AdmissionError 로 나가므로 여기 도달하지 않는다.
        """
        return "reentry_ok" if self.already else "admitted"


@dataclass
class RevokeResult:
    """입장 취소(오스캔 복구) 결과. §13 체크인 undo/취소."""

    revoked: bool  # 실제로 원장 1행을 삭제했는지(멱등: 없으면 False)
    attended_date: date
    was_last_admission: bool  # 삭제 후 이 티켓에 다른 입장이 남지 않는지(부작용 되돌림 판정)
    status_reverted: bool  # status USED→ACTIVE 로 원복했는지
    first_checked_in_reset: bool  # first_checked_in_at 을 리셋했는지


def to_kst_date(dt: datetime) -> date:
    """UTC/naive/aware datetime 을 KST 로컬 날짜로 변환.

    naive 는 UTC 로 간주(v2 는 timezone-aware UTC 저장이 표준이나 SQLite 테스트에선
    naive 로 돌아올 수 있음). UTC ::date 직접 캐스트 금지 — 반드시 KST 변환 후 date().
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST).date()


def _event_date_range(event: Event) -> tuple[date, date]:
    """이벤트 유효 입장일 범위(KST). event_date_end 미설정 시 단일일."""
    start = to_kst_date(event.event_date)
    end = to_kst_date(event.event_date_end) if event.event_date_end is not None else start
    if end < start:
        end = start
    return start, end


async def _tier_admission_days(db: AsyncSession, ticket: Ticket) -> list[date] | None:
    """등급별 입장 가능일(KST) — `seat_tiers.tier_metadata.admission_days`.

    다일 대회는 등급마다 입장일이 다르다(KLPGA: 주중권=목·금 / 주말권=토·일).
    이벤트 기간(`_event_date_range`)만으로는 "주중권으로 결승일 입장"을 막을 수 없어
    등급 단위 창을 둔다. 미설정(None)이면 종전대로 이벤트 기간만 적용한다.

    🔴 형식이 깨졌으면 **빈 목록으로 흘리지 않고 예외를 낸다**. 빈 목록으로 흘리면
       "입장 가능일이 하나도 없다"가 되어 정상 관객이 전원 거부되고, 반대로 None 으로
       흘리면 제한이 조용히 사라져 아무 날이나 입장된다. 둘 다 조용한 실패다.
    """
    if ticket.tier_id is None:
        return None
    from app.models.event import SeatTier

    tier = await db.get(SeatTier, ticket.tier_id)
    meta = getattr(tier, "tier_metadata", None) if tier is not None else None
    if not isinstance(meta, dict):
        return None
    raw = meta.get("admission_days")
    if raw is None:
        return None
    if not isinstance(raw, list) or not raw:
        raise AdmissionError(
            "TIER_ADMISSION_DAYS_INVALID",
            "등급 입장일 설정이 올바르지 않아 입장을 판정할 수 없습니다",
        )
    days: list[date] = []
    for item in raw:
        try:
            days.append(date.fromisoformat(str(item)))
        except ValueError as exc:
            raise AdmissionError(
                "TIER_ADMISSION_DAYS_INVALID",
                "등급 입장일 설정이 올바르지 않아 입장을 판정할 수 없습니다",
            ) from exc
    return days


async def admit(
    db: AsyncSession,
    ticket: Ticket,
    event: Event,
    now: datetime,
    *,
    checked_in_by: uuid.UUID | None = None,
    method: str = "qr_scan",
    run_side_effects: bool = True,
) -> AdmitResult:
    """공통 입장 판정 (계약서 §3.3).

    호출측 계약:
    - `db` 트랜잭션은 이 함수가 **commit 하지 않는다**(flush 만). 호출측이 commit.
    - 반환된 result 로 응답을 구성한다. 거부는 AdmissionError 로 전파.
    - CANCELLED/EXPIRED → AdmissionError("NOT_ADMITTABLE").
    - 유효일 밖 → AdmissionError("NOT_ADMISSION_DAY").
    """
    # 1) 소진/취소 상태 거부.
    if ticket.status in (TicketStatus.CANCELLED, TicketStatus.EXPIRED):
        raise AdmissionError(
            "NOT_ADMITTABLE",
            # 게이트 화면에 그대로 나가는 문구다 — 스태프·관객이 읽는다. 영문 내부 메시지를
            # 두면 go 가 노출을 포기하고 뭉뚱그린 폴백을 쓰게 된다(실측).
            "취소되었거나 만료된 티켓입니다"
            if ticket.status == TicketStatus.CANCELLED
            else "만료된 티켓입니다",
        )

    admission_mode = (getattr(event, "admission_mode", None) or "single").lower()
    today = to_kst_date(now)
    start, end = _event_date_range(event)

    # 2-a) 등급별 입장 가능일 — 설정돼 있으면 **모드보다 먼저·모든 모드에** 적용한다.
    #      등급창은 "이 티켓이 어느 날 유효한가"라는 상품 정의이고, 모드는 "며칠 쓸 수 있나"라서
    #      층위가 다르다. 등급창 밖이면 모드와 무관하게 입장이 아니다.
    tier_days = await _tier_admission_days(db, ticket)
    if tier_days is not None and today not in tier_days:
        raise AdmissionError(
            "NOT_ADMISSION_DAY",
            "이 등급의 입장 가능일이 아닙니다",
        )

    # 2) admission_mode 별 유효일 검사 (KST).
    if admission_mode == "allpass":
        if not (start <= today <= end):
            raise AdmissionError("NOT_ADMISSION_DAY", "오늘은 입장 가능일이 아닙니다")
    elif admission_mode == "daypass":
        if ticket.admission_day is not None:
            # 지정/확정된 daypass — 해당일만 입장.
            if today != ticket.admission_day:
                raise AdmissionError(
                    "NOT_ADMISSION_DAY",
                    "지정된 입장일이 아닙니다",
                )
        else:
            # 선택형 미확정 — 이벤트 범위 내여야 하며, 오늘로 확정.
            if not (start <= today <= end):
                raise AdmissionError("NOT_ADMISSION_DAY", "오늘은 입장 가능일이 아닙니다")
    else:
        # single = **티켓 생애 1회 입장**(당일 재입장은 허용).
        #
        # 🔴 2026-07-28 실측 결함: 종전 single 은 아무 검사도 하지 않았다. 그런데 멱등 SoT 가
        #    per-day 원장이라 날짜가 바뀌면 '오늘 원장 없음' → 신규 입장이 성립한다. 결과적으로
        #    다일 이벤트에서 **1장으로 매일 입장**됐다(주중권 15,000원으로 목·금·토·일 4일 전부
        #    admitted 재현). 모드 이름과 정반대 동작이고, 재고·매출이 직접 새는 경로다.
        #
        # 날짜 '범위'는 여전히 강제하지 않는다 — 사전/현장 사정으로 이벤트일 밖 입장을 허용하던
        # 기존 계약을 유지한다(그 완화가 이 결함의 원인은 아니었다). 막는 것은 **다른 날 재입장**뿐이다.
        prior = (
            await db.execute(
                select(EventAdmission.attended_date).where(
                    EventAdmission.ticket_id == ticket.id,
                    EventAdmission.attended_date != today,
                ).limit(1)
            )
        ).scalar_one_or_none()
        if prior is not None:
            raise AdmissionError(
                "ALREADY_ADMITTED",
                f"이미 {prior} 에 입장한 티켓입니다 (1회 입장권)",
            )

    # 3) 오늘 이미 입장? (멱등 SoT = event_admissions)
    existing = (
        await db.execute(
            select(EventAdmission).where(
                EventAdmission.ticket_id == ticket.id,
                EventAdmission.attended_date == today,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return AdmitResult(
            admission=existing,
            already=True,
            first_admission=False,
            attended_date=today,
        )

    # 4) 원장 INSERT (UNIQUE 로 동시 2게이트 방어). 패자는 IntegrityError → already.
    admission = EventAdmission(
        ticket_id=ticket.id,
        event_id=event.id,
        attended_date=today,
        checked_in_at=now,
        checked_in_by=checked_in_by,
        method=method,
    )
    try:
        async with db.begin_nested():
            db.add(admission)
            await db.flush()
    except IntegrityError:
        # 동시 게이트가 먼저 오늘 원장을 만들었다 → 패자 already 처리.
        existing = (
            await db.execute(
                select(EventAdmission).where(
                    EventAdmission.ticket_id == ticket.id,
                    EventAdmission.attended_date == today,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            # 이론상 도달 불가(UNIQUE 충돌인데 행이 없음) — 방어적 재전파.
            raise
        return AdmitResult(
            admission=existing,
            already=True,
            first_admission=False,
            attended_date=today,
        )

    # 5) 최초 입장 여부 — first_checked_in_at 로 판정(부작용 1회 게이트).
    first_admission = ticket.first_checked_in_at is None

    # daypass 선택형 확정: 첫 입장일을 admission_day 로 고정.
    if admission_mode == "daypass" and ticket.admission_day is None:
        ticket.admission_day = today

    deposit_refunded = False
    if first_admission:
        ticket.first_checked_in_at = now
        # 표시/호환용 스칼라 — 최초 1회만 세팅(재스캔·다일 입장으로 덮어쓰지 않음).
        if ticket.checked_in_at is None:
            ticket.checked_in_at = now
        if run_side_effects:
            deposit_refunded = await _run_first_admission_side_effects(db, ticket, event)

    # 6) status 갱신 (계약서 §3.2).
    #    single/daypass → USED. allpass → ACTIVE 유지(종료 후 lazy/cron 으로 USED).
    if admission_mode == "allpass":
        # ACTIVE 유지. (PENDING 이었던 경우는 최초 입장으로 ACTIVE 승격.)
        if ticket.status == TicketStatus.PENDING:
            ticket.status = TicketStatus.ACTIVE
    else:
        ticket.status = TicketStatus.USED

    await db.flush()

    return AdmitResult(
        admission=admission,
        already=False,
        first_admission=first_admission,
        attended_date=today,
        deposit_refunded=deposit_refunded,
    )


async def _run_first_admission_side_effects(
    db: AsyncSession, ticket: Ticket, event: Event
) -> bool:
    """최초 입장 1회 부작용: 보증금 환불 · 체크인 포인트 · NFT 메타데이터.

    각 부작용은 개별 try/except 로 격리(하나 실패가 입장 자체를 막지 않음).
    같은 DB 트랜잭션 내 write 이므로 COMMIT 전 crash 시 원장과 함께 원자적 롤백.
    """
    # 지연 import — 순환 참조 방지.
    from app.services.nft_service import NftService
    from app.services.point_service import PointService

    deposit_refunded = await _try_refund_deposit(db, ticket)

    if ticket.current_owner_id is not None:
        point_service = PointService(db)
        for pt in (PointType.FAN, PointType.SOCIAL):
            try:
                await point_service.earn(
                    user_id=ticket.current_owner_id,
                    point_type=pt,
                    amount=5,
                    tx_type=PointTransactionType.EARN_CHECKIN,
                    reference_id=event.id,
                    description="체크인 포인트 적립",
                    # 멱등: 티켓 최초 입장 1회. 재실행/다일에도 중복 적립 차단.
                    idempotency_key=f"checkin:{ticket.id}:{pt.value}",
                )
            except Exception:
                logger.warning(
                    "Failed to award check-in points for user %s",
                    ticket.current_owner_id,
                    exc_info=True,
                )

    if getattr(event, "nft_enabled", False):
        try:
            nft_service = NftService(db)
            await nft_service.generate_metadata(ticket.id)
        except Exception:
            logger.warning(
                "Failed to generate NFT metadata for ticket %s", ticket.id, exc_info=True
            )

    return deposit_refunded


async def _try_refund_deposit(db: AsyncSession, ticket: Ticket) -> bool:
    """보증금 주문이 held 면 환불 처리(입장 확인 → 예치금 반환)."""
    if ticket.current_owner_id is None:
        return False
    result = await db.execute(
        select(Order).where(
            Order.user_id == ticket.current_owner_id,
            Order.event_id == ticket.event_id,
            Order.order_type == OrderType.DEPOSIT,
            Order.status == OrderStatus.DEPOSIT_HELD,
        )
    )
    deposit_order = result.scalar_one_or_none()
    if deposit_order:
        deposit_order.status = OrderStatus.DEPOSIT_REFUNDED
        return True
    return False


async def revoke_admission(
    db: AsyncSession,
    ticket: Ticket,
    event: Event,
    attended_date: date,
) -> RevokeResult:
    """입장 취소(오스캔 복구) — §13 체크인 undo/취소.

    게이트 오스캔(스태프 테스트·잘못된 게이트/리스트) 복구 도구. 특정 `(ticket_id, attended_date)`
    입장 원장 1행을 삭제하고, 그날이 이 티켓의 유일 입장이었다면 최초입장 부작용을 되돌린다.

    멱등·동시성:
    - 원장이 없으면 `revoked=False` 로 조용히 반환(중복 취소·이미 취소 안전).
    - 티켓 행을 `FOR UPDATE` 로 잠가 동시 재입장/취소 레이스를 직렬화.
    - 삭제 후 남은 입장 수로 "유일 입장" 여부를 재판정 → 남아있으면 status/first_checked_in_at 불변.

    되돌림 범위:
    - status: daypass/single 이 이 입장으로 USED 였다면 ACTIVE 로 원복(allpass 는 원래 ACTIVE 유지).
    - first_checked_in_at: 유일 입장이었으면 None 으로 리셋(양도가드 해제·다음 입장이 다시 '최초'가 됨).
    - admission_day: 선택형 daypass 가 이 날로 확정됐고 유일 입장이면 None 으로 되돌려 재선택 허용.
    - 포인트/NFT/보증금환불: **정책상 자동 회수 보류**(주석). 이미 적립된 포인트를 게이트에서 즉시
      차감하면 사용자 잔액 음수·환불분쟁 소지 → 회수는 별도 정산 정책으로 처리. idempotency_key
      가 `checkin:{ticket.id}:...` 라 재입장 시 중복적립은 어차피 없다.
    - go 웹훅/attendees 캐시 원복은 호출측(go route)이 COMMIT 후 수행. 이 함수는 순수 v2 DB 경계.

    호출측 계약: 이 함수는 commit 하지 않는다(flush). 호출측이 commit.
    """
    # 티켓 행 잠금 — 동시 재입장/취소 직렬화(첨부 SELECT ... FOR UPDATE).
    locked = (
        await db.execute(
            select(Ticket).where(Ticket.id == ticket.id).with_for_update()
        )
    ).scalar_one_or_none()
    if locked is not None:
        ticket = locked

    admission = (
        await db.execute(
            select(EventAdmission).where(
                EventAdmission.ticket_id == ticket.id,
                EventAdmission.attended_date == attended_date,
            )
        )
    ).scalar_one_or_none()

    if admission is None:
        # 이미 취소됐거나 그날 입장 없음 — 멱등 no-op.
        return RevokeResult(
            revoked=False,
            attended_date=attended_date,
            was_last_admission=False,
            status_reverted=False,
            first_checked_in_reset=False,
        )

    await db.delete(admission)
    await db.flush()

    # 삭제 후 남은 입장 수(FOR UPDATE 로 잠근 상태라 원자적).
    remaining = (
        await db.execute(
            select(EventAdmission.id).where(EventAdmission.ticket_id == ticket.id)
        )
    ).scalars().all()
    was_last = len(remaining) == 0

    admission_mode = (getattr(event, "admission_mode", None) or "single").lower()

    status_reverted = False
    first_reset = False
    if was_last:
        # 유일 입장을 되돌림 → 이 티켓은 '미입장' 상태로 복귀.
        # status: single/daypass 가 USED 였으면 ACTIVE 로 원복(발권상태 복구).
        if ticket.status == TicketStatus.USED:
            ticket.status = TicketStatus.ACTIVE
            status_reverted = True
        # first_checked_in_at 리셋 — 양도가드 해제. 다음 입장이 다시 '최초 입장'으로 부작용 1회.
        if ticket.first_checked_in_at is not None:
            ticket.first_checked_in_at = None
            first_reset = True
        # 표시/호환용 스칼라도 정리.
        ticket.checked_in_at = None
        # 선택형 daypass 가 이 날로 확정됐던 경우 재선택 허용(admission_day == 취소일 일 때만).
        # 지정일(F2 事前지정) daypass 는 애초에 다른 날 스캔이 admit 에서 거부되므로, admission_day
        # 가 취소일과 같은 것은 '이 날로 (재)확정된' 상태 → 되돌려 재선택/재확정을 허용해도 안전.
        if admission_mode == "daypass" and ticket.admission_day == attended_date:
            ticket.admission_day = None
        await db.flush()

    return RevokeResult(
        revoked=True,
        attended_date=attended_date,
        was_last_admission=was_last,
        status_reverted=status_reverted,
        first_checked_in_reset=first_reset,
    )
