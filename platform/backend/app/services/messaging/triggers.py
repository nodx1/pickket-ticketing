"""트랜잭션 알림·조직자 인앱 알림 트리거 — v2 판정지점 직결 (go 왕복 제거).

레벨2 영역C 3항: internal_commerce 의 state-changed/order 판정지점에서 직접 호출한다.
  - 구매완료(purchase_complete)·환불완료(refund_complete) = **트랜잭션(정보성) 알림** → 구매자.
  - new_order·sold_out·payment_failed = **조직자 인앱 알림**(OrganizerNotification) → 대시보드.

⚠️ 원자 전환(이중발송 방지): 모든 트리거는 settings.ORGANIZER_MESSAGING_V2_ENABLED 게이트 뒤에
   있다. 기본 OFF = dormant(go 소유 유지). ON = v2 소유(go 크론/트리거 동시 OFF 컷오버 전제).

⚠️ 트랜잭션 경계: 이 트리거들은 **호출측이 db.commit() 을 마친 뒤**(state-changed 투영 지점)
   호출해야 한다. 알림 생성/발송은 원장 write 를 별도 커밋으로 수행 — 커밋된 주문상태를 근거로
   외부호출/인앱알림을 하므로 "커밋 후 외부호출" 계약을 만족한다. best-effort(트리거 실패가
   이미 커밋된 주문 상태를 되돌리지 않음 — 로그만 남기고 삼킨다).

provider 발송은 W5-PROVIDER 로 실배선됨(default_sender). 트랜잭션 알림은 dispatch_one(원장
경로)로 선기록되며, NCP 미설정이면 미배선 스텁이 failed(provider_unwired)로 정정된다.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.event import Event
from app.models.guest import Guest
from app.models.order import Order
from app.models.organizer_messaging import OrganizerNotification
from app.models.user import User
from app.services.messaging.compliance import Channel
from app.services.messaging.dispatch_service import (
    DispatchParams,
    ProviderSender,
    default_sender,
    dispatch_one,
)

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return bool(getattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", False))


async def _buyer_contact(
    db: AsyncSession, order: Order
) -> tuple[str | None, str | None, str | None]:
    """주문 구매자 (email, phone, name) — 회원/게스트."""
    if order.user_id is not None:
        u = await db.get(User, order.user_id)
        if u is not None:
            return u.email, u.phone, u.name
    if order.guest_id is not None:
        g = await db.get(Guest, order.guest_id)
        if g is not None:
            return g.email, g.phone_enc, g.name
    return None, None, None


async def _event_owner_and_title(
    db: AsyncSession, event_id: uuid.UUID
) -> tuple[uuid.UUID | None, str]:
    ev = await db.get(Event, event_id)
    if ev is None:
        return None, ""
    return ev.organizer_id, ev.title


async def _send_transactional(
    db: AsyncSession,
    *,
    account_id: uuid.UUID,
    order: Order,
    kind: str,  # 'purchase_complete' | 'refund_complete'
    event_title: str,
    sender: ProviderSender | None,
) -> None:
    """구매자에게 정보성 트랜잭션 알림 — 이메일 우선(회원/게스트 공통).

    message_id = 논리 발송 그룹 id(원장 멱등키 성분): f"{kind}:{order.id}" 를 UUIDv5 로 안정화.
    동일 주문 재트리거(멱등)면 message_deliveries UNIQUE 로 이중발송 차단.
    """
    email, phone, name = await _buyer_contact(db, order)
    if not email and not phone:
        return
    sender = sender or default_sender()
    ns = uuid.UUID("00000000-0000-0000-0000-0000000000c2")  # 영역C 트랜잭션 네임스페이스
    message_id = str(uuid.uuid5(ns, f"{kind}:{order.id}"))

    if kind == "purchase_complete":
        subject = f"[{event_title}] 예매가 완료되었습니다"
        body = f"{name or '고객'}님, [{event_title}] 예매가 정상 완료되었습니다."
    else:
        subject = f"[{event_title}] 환불이 완료되었습니다"
        body = f"{name or '고객'}님, [{event_title}] 환불이 정상 처리되었습니다."

    targets: list[tuple[Channel, str]] = []
    if email:
        targets.append(("email", email))
    if phone:
        targets.append(("sms", phone))
    for ch, contact in targets:
        params = DispatchParams(
            account_id=str(account_id),
            channel=ch,
            message_type="informational",
            to=contact,
            body=body,
            subject=subject,
            message_id=message_id,
        )
        try:
            await dispatch_one(db, params, sender=sender)
        except NotImplementedError:
            # provider 미배선: 선기록 sending 잔류 스윕(조용한 유실 방지).
            from app.services.messaging.message_dispatch import _sweep_unwired

            await _sweep_unwired(db, uuid.UUID(message_id), ch, contact)
        except Exception:  # noqa: BLE001 — best-effort
            logger.exception("트랜잭션 알림 실패: kind=%s order=%s ch=%s", kind, order.id, ch)


async def _add_organizer_notification(
    db: AsyncSession,
    *,
    account_id: uuid.UUID,
    event_id: uuid.UUID | None,
    ntype: str,
    title: str,
    message: str,
    metadata: dict | None = None,
) -> None:
    db.add(
        OrganizerNotification(
            account_id=account_id,
            event_id=event_id,
            type=ntype,
            title=title,
            message=message,
            notif_metadata=metadata,
        )
    )
    await db.commit()


# ── 공개 트리거(internal_commerce 판정지점에서 호출) ──────────────────────────


async def on_order_confirmed(
    db: AsyncSession, order: Order, *, sender: ProviderSender | None = None
) -> None:
    """구매완료 — 구매자에게 트랜잭션 알림 + 조직자 인앱 new_order. (state-changed 투영 후 호출)"""
    if not _enabled():
        return
    try:
        owner, title = await _event_owner_and_title(db, order.event_id)
        if owner is None:
            return
        await _send_transactional(
            db, account_id=owner, order=order, kind="purchase_complete",
            event_title=title, sender=sender,
        )
        await _add_organizer_notification(
            db, account_id=owner, event_id=order.event_id, ntype="new_order",
            title="새 주문", message=f"[{title}] 새 주문이 접수되었습니다.",
            metadata={"order_id": str(order.id)},
        )
    except Exception:  # noqa: BLE001 — best-effort(커밋된 주문상태 불변)
        logger.exception("on_order_confirmed 트리거 실패: order=%s", order.id)


async def on_order_refunded(
    db: AsyncSession, order: Order, *, sender: ProviderSender | None = None
) -> None:
    """환불완료 — 구매자에게 트랜잭션 알림. (state-changed 투영 후 호출)"""
    if not _enabled():
        return
    try:
        owner, title = await _event_owner_and_title(db, order.event_id)
        if owner is None:
            return
        await _send_transactional(
            db, account_id=owner, order=order, kind="refund_complete",
            event_title=title, sender=sender,
        )
    except Exception:  # noqa: BLE001
        logger.exception("on_order_refunded 트리거 실패: order=%s", order.id)


async def on_payment_failed(
    db: AsyncSession, order: Order, *, reason: str | None = None
) -> None:
    """결제실패 — 조직자 인앱 payment_failed. (판정지점 커밋 후 호출)"""
    if not _enabled():
        return
    try:
        owner, title = await _event_owner_and_title(db, order.event_id)
        if owner is None:
            return
        await _add_organizer_notification(
            db, account_id=owner, event_id=order.event_id, ntype="payment_failed",
            title="결제 실패", message=f"[{title}] 결제 실패가 발생했습니다.",
            metadata={"order_id": str(order.id), "reason": reason},
        )
    except Exception:  # noqa: BLE001
        logger.exception("on_payment_failed 트리거 실패: order=%s", order.id)


async def on_sold_out(
    db: AsyncSession, *, account_id: uuid.UUID, event_id: uuid.UUID, event_title: str
) -> None:
    """매진 — 조직자 인앱 sold_out. (판정지점 커밋 후 호출)"""
    if not _enabled():
        return
    try:
        await _add_organizer_notification(
            db, account_id=account_id, event_id=event_id, ntype="sold_out",
            title="매진", message=f"[{event_title}] 티켓이 매진되었습니다.",
        )
    except Exception:  # noqa: BLE001
        logger.exception("on_sold_out 트리거 실패: event=%s", event_id)
