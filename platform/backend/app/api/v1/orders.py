"""Order and payment endpoints (PortOne-ready)."""

import logging
import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.payment_webhook import secure_portone_webhook_request
from app.core.config import settings
from app.core.database import get_db, get_read_db
from app.core.audit import write_audit_log
from app.core.errors import api_error, client_error_detail, ErrorCode
from app.middleware.auth import get_current_user
from app.middleware.rate_limit import rate_limit_payment, rate_limit_webhook
from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.models.refund import Refund
from app.models.user import User
from app.schemas.order import (
    OrderResponse,
    PaymentConfirm,
    PaymentPrepareRequest,
    PaymentPrepareResponse,
    RefundRequest,
    RefundResponse,
    PaymentVoidRequest,
    PaymentWebhookResponse,
    PartialRefundRequest,
    QuantityRefundRequest,
)
from app.services.payment_service import PaymentService
from app.services.refund_service import RefundError, RefundService
from app.services.partial_refund_service import PartialRefundError, PartialRefundService

logger = logging.getLogger(__name__)
router = APIRouter()


def _drain_propagations(propagations: list[dict]) -> None:
    """Enqueue v2 → go propagation hints AFTER db.commit().

    Guarded on both GO_INTERNAL_BASE_URL and GO_WEBHOOK_SECRET so the code
    is a no-op until staging/prod env is flipped. Failures here must never
    affect the HTTP response — propagation is strictly downstream.
    """
    if not propagations:
        return
    if not (settings.GO_INTERNAL_BASE_URL and settings.GO_WEBHOOK_SECRET):
        return
    try:
        from app.tasks.propagate_order_event import propagate_order_event_to_go

        for hint in propagations:
            propagate_order_event_to_go.delay(
                event=hint["event"],
                order_id=hint["order_id"],
                data=hint["data"],
            )
            logger.info(
                "Enqueued v2→go propagation: event=%s order_id=%s",
                hint["event"], hint["order_id"],
            )
    except Exception:
        logger.exception("Failed to enqueue v2→go propagation (non-fatal)")


def _ensure_manual_payment_api_enabled() -> None:
    if settings.ENVIRONMENT == "production" and not settings.PAYMENT_MANUAL_API_ENABLED:
        raise api_error(
            ErrorCode.FORBIDDEN,
            "Manual payment endpoints are disabled in production",
        )


async def _get_owned_order(
    db: AsyncSession,
    *,
    order_id: uuid.UUID,
    user_id: uuid.UUID,
) -> Order:
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise api_error(ErrorCode.ORDER_NOT_FOUND)
    if order.user_id != user_id:
        raise api_error(ErrorCode.FORBIDDEN, "Not your order")
    return order


async def _get_refundable_order(
    db: AsyncSession,
    *,
    order_id: uuid.UUID,
    user: User,
) -> Order:
    """Allow refunds for order owner or event organizer."""
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise api_error(ErrorCode.ORDER_NOT_FOUND)

    if order.user_id == user.id:
        return order

    if user.is_organizer:
        event_result = await db.execute(
            select(Event.id).where(
                Event.id == order.event_id,
                Event.organizer_id == user.id,
            )
        )
        if event_result.scalar_one_or_none() is not None:
            return order

    raise api_error(ErrorCode.FORBIDDEN, "Not your order")


@router.get("/{order_id}/status")
async def order_status(
    order_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Lightweight order status polling endpoint for async purchase flow.

    Returns only status, message, and ticket_ids — minimal payload for fast polling.
    Clients should poll every 1-2 seconds until status != 'pending'.
    """
    result = await db.execute(
        select(Order.status, Order.quantity, Order.unit_price, Order.total_amount)
        .where(Order.id == order_id, Order.user_id == user.id)
    )
    row = result.one_or_none()
    if not row:
        raise api_error(ErrorCode.ORDER_NOT_FOUND)

    order_status_val, quantity, unit_price, total_amount = row

    response: dict = {
        "order_id": str(order_id),
        "status": order_status_val.value if hasattr(order_status_val, "value") else str(order_status_val),
        "processing": order_status_val == OrderStatus.PENDING,
    }

    # If processing is done, include ticket IDs
    if order_status_val == OrderStatus.PAYMENT_REQUIRED:
        from app.models.ticket import Ticket
        ticket_result = await db.execute(
            select(Ticket.id).where(Ticket.purchase_order_id == order_id)
        )
        response["ticket_ids"] = [str(r[0]) for r in ticket_result.all()]
        response["unit_price"] = float(unit_price) if unit_price else 0
        response["total_price"] = float(total_amount) if total_amount else 0
        response["message"] = f"주문이 생성되었습니다. {quantity}장의 티켓이 예약되었습니다."
    elif order_status_val == OrderStatus.PENDING:
        response["message"] = "주문 처리 중입니다."
    elif order_status_val == OrderStatus.CANCELLED:
        response["message"] = "주문이 취소되었습니다."
    else:
        response["message"] = f"주문 상태: {order_status_val.value if hasattr(order_status_val, 'value') else order_status_val}"

    return response


@router.get("/my", response_model=list[OrderResponse])
async def my_orders(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    status: str | None = Query(None),
    event_id: uuid.UUID | None = Query(None),
    cursor: str | None = Query(None, description="Cursor for keyset pagination (created_at:id)"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get all orders for the current user, optionally filtered by status/event.

    Supports cursor-based (keyset) pagination for efficient deep paging.
    Pass the ``cursor`` value from the last item to get the next page.
    Falls back to OFFSET when cursor is not provided (backward compatible).
    """
    from datetime import datetime as _dt

    stmt = select(Order).where(Order.user_id == user.id)
    if status:
        stmt = stmt.where(Order.status == status)
    if event_id:
        stmt = stmt.where(Order.event_id == event_id)

    if cursor:
        # Cursor format: "ISO_DATETIME:UUID"
        try:
            ts_str, id_str = cursor.rsplit(":", 1)
            cursor_ts = _dt.fromisoformat(ts_str)
            cursor_id = uuid.UUID(id_str)
            # Keyset condition: (created_at, id) < (cursor_ts, cursor_id)
            stmt = stmt.where(
                (Order.created_at < cursor_ts)
                | ((Order.created_at == cursor_ts) & (Order.id < cursor_id))
            )
        except (ValueError, TypeError):
            logger.debug("cursor pagination parsing failed", exc_info=True)

    result = await db.execute(
        stmt.order_by(Order.created_at.desc(), Order.id.desc()).offset(0 if cursor else skip).limit(limit)
    )
    orders = result.scalars().all()
    return [OrderResponse.model_validate(o) for o in orders]


@router.post("/{order_id}/payment/prepare", response_model=PaymentPrepareResponse)
async def prepare_payment(
    order_id: uuid.UUID,
    data: PaymentPrepareRequest,
    request: Request,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Prepare PortOne payment and return redirect information."""
    await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        prepared = await service.initiate_payment(
            order_id=order_id,
            idempotency_key=data.idempotency_key,
            success_url=data.success_url,
            fail_url=data.fail_url,
            pay_method=data.pay_method,
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="payment.prepare",
            resource_type="order",
            resource_id=str(order_id),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        return prepared
    except ValueError as e:
        logger.warning("Payment prepare failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 준비에 실패했습니다."),
        )


@router.post("/webhooks/portone", response_model=PaymentWebhookResponse)
async def portone_webhook(
    request: Request,
    _rate_limit: None = Depends(rate_limit_webhook),
    db: AsyncSession = Depends(get_db),
):
    """PortOne server-to-server webhook endpoint (Standard Webhooks)."""
    raw_body = await request.body()
    await secure_portone_webhook_request(request, raw_body)
    service = PaymentService(db)
    try:
        await service.handle_portone_webhook(raw_body=raw_body)
        await db.commit()
        return PaymentWebhookResponse(ok=True, message="accepted")
    except PermissionError as e:
        logger.warning("Webhook permission denied: %s", e)
        raise api_error(ErrorCode.INSUFFICIENT_PERMISSIONS, "접근 권한이 없습니다")
    except ValueError as e:
        logger.warning("Webhook processing failed", exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 웹훅 처리에 실패했습니다."),
        )


@router.get("/my/refunds", response_model=list[OrderResponse])
async def my_refunds(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get current user's refund history based on Refund records."""
    refund_order_ids = (
        await db.execute(
            select(Refund.order_id)
            .join(Order, Order.id == Refund.order_id)
            .where(Order.user_id == user.id)
            .distinct()
        )
    ).scalars().all()
    if not refund_order_ids:
        return []

    result = await db.execute(
        select(Order)
        .where(Order.id.in_(refund_order_ids))
        .order_by(Order.created_at.desc())
    )
    return [OrderResponse.model_validate(o) for o in result.scalars().all()]


@router.get("/{order_id}", response_model=OrderResponse)
async def get_order(
    order_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get a single order by ID. Must belong to the current user."""
    order = await _get_owned_order(db, order_id=order_id, user_id=user.id)
    return OrderResponse.model_validate(order)


@router.post("/{order_id}/pay", response_model=OrderResponse)
async def confirm_payment(
    order_id: uuid.UUID,
    data: PaymentConfirm,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manual confirmation fallback endpoint.

    Use this endpoint while frontend/PG callbacks are being integrated.
    """
    _ensure_manual_payment_api_enabled()
    await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        updated_order = await service.confirm_payment(
            order_id=order_id,
            pg_provider=data.pg_provider,
            pg_txn_id=data.pg_transaction_id,
            payment_id=data.payment_id,
            amount=data.amount,
            source="manual_api",
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="payment.confirm",
            resource_type="order",
            resource_id=str(order_id),
            new_value={"pg_provider": data.pg_provider, "amount": data.amount},
        )
        await db.commit()
        _drain_propagations(service.propagations)
        return updated_order
    except ValueError as e:
        logger.warning("Manual payment confirmation failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 확인에 실패했습니다."),
        )


@router.post("/{order_id}/authorize", response_model=OrderResponse)
async def authorize_payment(
    order_id: uuid.UUID,
    data: PaymentConfirm,
    request: Request,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Authorize payment (hold) without capture."""
    _ensure_manual_payment_api_enabled()
    await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        updated_order = await service.authorize_payment(
            order_id=order_id,
            pg_provider=data.pg_provider,
            pg_txn_id=data.pg_transaction_id,
            payment_id=data.payment_id,
            amount=data.amount,
            source="manual_api",
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="payment.authorize",
            resource_type="order",
            resource_id=str(order_id),
            new_value={"pg_provider": data.pg_provider, "amount": data.amount},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        return updated_order
    except ValueError as e:
        logger.warning("Payment authorization failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 승인에 실패했습니다."),
        )


@router.post("/{order_id}/capture", response_model=OrderResponse)
async def capture_payment(
    order_id: uuid.UUID,
    request: Request,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Capture a previously authorized payment."""
    _ensure_manual_payment_api_enabled()
    await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        updated_order = await service.capture_payment(
            order_id=order_id,
            source="manual_api",
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="payment.capture",
            resource_type="order",
            resource_id=str(order_id),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        _drain_propagations(service.propagations)
        return updated_order
    except ValueError as e:
        logger.warning("Payment capture failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 매입에 실패했습니다."),
        )


@router.post("/{order_id}/void", response_model=OrderResponse)
async def void_payment(
    order_id: uuid.UUID,
    data: PaymentVoidRequest,
    request: Request,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Void an authorization and cancel the order."""
    _ensure_manual_payment_api_enabled()
    await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        updated_order = await service.void_payment(
            order_id=order_id,
            reason=data.reason,
            source="manual_api",
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="payment.void",
            resource_type="order",
            resource_id=str(order_id),
            new_value={"reason": data.reason},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        return updated_order
    except ValueError as e:
        logger.warning("Payment void failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 취소에 실패했습니다."),
        )


@router.post("/{order_id}/refund", response_model=RefundResponse)
async def refund_order(
    order_id: uuid.UUID,
    data: RefundRequest,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initiate refund for a paid/confirmed order."""
    order = await _get_refundable_order(db, order_id=order_id, user=user)
    service = RefundService(db)
    try:
        refund = await service.request_refund(
            order_id=order_id,
            reason=data.reason,
            amount=data.amount,
            ticket_ids=data.ticket_ids,
            idempotency_key=data.idempotency_key,
            initiated_by="organizer" if order.user_id != user.id else "user",
            initiated_by_user_id=user.id,
        )
        await db.commit()
        _drain_propagations(service.propagations)
        return RefundResponse(
            refund_id=refund.id,
            order_id=order_id,
            status=order.status.value if hasattr(order.status, "value") else str(order.status),
            refund_status=refund.status.value if hasattr(refund.status, "value") else str(refund.status),
            refund_amount=float(refund.amount),
            original_amount=float(order.total_amount),
            reason=refund.reason,
            requires_approval=refund.requires_approval,
            ticket_ids=[item.ticket_id for item in refund.items],
            refunded_at=refund.processed_at or refund.requested_at,
        )
    except RefundError as e:
        logger.warning("Refund request failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "환불 요청에 실패했습니다."),
        )


@router.post("/{order_id}/partial-refund", response_model=RefundResponse)
async def partial_refund_order(
    order_id: uuid.UUID,
    data: PartialRefundRequest,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """아이템 단위 부분 환불 — 특정 티켓과 금액을 지정하여 환불."""
    order = await _get_refundable_order(db, order_id=order_id, user=user)
    service = PartialRefundService(db)
    try:
        items = [{"ticket_id": item.ticket_id, "amount": item.amount} for item in data.items]
        refund = await service.process_partial_refund(
            order_id=order_id,
            items=items,
            reason=data.reason,
            initiated_by="organizer" if order.user_id != user.id else "user",
            initiated_by_user_id=user.id,
            idempotency_key=data.idempotency_key,
        )
        await db.commit()
        _drain_propagations(service.propagations)
        return RefundResponse(
            refund_id=refund.id,
            order_id=order_id,
            status=order.status.value if hasattr(order.status, "value") else str(order.status),
            refund_status=refund.status.value if hasattr(refund.status, "value") else str(refund.status),
            refund_amount=float(refund.amount),
            original_amount=float(order.total_amount),
            reason=refund.reason,
            requires_approval=refund.requires_approval,
            ticket_ids=[item.ticket_id for item in refund.items],
            refunded_at=refund.processed_at or refund.requested_at,
        )
    except PartialRefundError as e:
        logger.warning("Partial refund failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "부분 환불에 실패했습니다."),
        )


@router.post("/{order_id}/quantity-refund", response_model=RefundResponse)
async def quantity_refund_order(
    order_id: uuid.UUID,
    data: QuantityRefundRequest,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """수량 기반 부분 환불 — N개 티켓을 환불 (가격 높은 순)."""
    order = await _get_refundable_order(db, order_id=order_id, user=user)
    service = PartialRefundService(db)
    try:
        refund = await service.process_quantity_refund(
            order_id=order_id,
            quantity=data.quantity,
            reason=data.reason,
            initiated_by="organizer" if order.user_id != user.id else "user",
            initiated_by_user_id=user.id,
            idempotency_key=data.idempotency_key,
        )
        await db.commit()
        _drain_propagations(service.propagations)
        return RefundResponse(
            refund_id=refund.id,
            order_id=order_id,
            status=order.status.value if hasattr(order.status, "value") else str(order.status),
            refund_status=refund.status.value if hasattr(refund.status, "value") else str(refund.status),
            refund_amount=float(refund.amount),
            original_amount=float(order.total_amount),
            reason=refund.reason,
            requires_approval=refund.requires_approval,
            ticket_ids=[item.ticket_id for item in refund.items],
            refunded_at=refund.processed_at or refund.requested_at,
        )
    except PartialRefundError as e:
        logger.warning("Quantity refund failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "수량 환불에 실패했습니다."),
        )


@router.post("/{order_id}/cancel", response_model=OrderResponse)
async def cancel_order(
    order_id: uuid.UUID,
    _rate_limit: None = Depends(rate_limit_payment),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an order and release held seats back to inventory."""
    order = await _get_owned_order(db, order_id=order_id, user_id=user.id)
    service = PaymentService(db)
    try:
        await service.cancel_order(order_id=order_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="order.cancel",
            resource_type="order",
            resource_id=str(order_id),
        )
        await db.commit()
        await db.refresh(order)
        return OrderResponse.model_validate(order)
    except ValueError as e:
        logger.warning("Order cancellation failed for order %s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "주문 취소에 실패했습니다."),
        )


@router.get("/{order_id}/receipt")
async def get_order_receipt(
    order_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Generate receipt data for a confirmed/paid order."""
    order = await _get_owned_order(db, order_id=order_id, user_id=user.id)

    if order.status not in (OrderStatus.CONFIRMED, OrderStatus.PAID):
        raise api_error(ErrorCode.BAD_REQUEST, "Receipt available only for confirmed/paid orders")

    # Get event info
    event_result = await db.execute(select(Event).where(Event.id == order.event_id))
    event = event_result.scalar_one_or_none()

    return {
        "receipt_number": f"PKT-{str(order.id)[:8].upper()}",
        "order_id": str(order.id),
        "event_title": event.title if event else "Unknown Event",
        "event_date": str(event.event_date) if event else None,
        "event_venue": event.venue if event else None,
        "tier_name": order.tier_name if hasattr(order, "tier_name") else None,
        "quantity": order.quantity,
        "unit_price": float(order.unit_price)
        if hasattr(order, "unit_price") and order.unit_price
        else None,
        "total_amount": float(order.total_amount),
        "payment_method": order.payment_method if hasattr(order, "payment_method") else None,
        "status": order.status.value,
        "buyer_name": user.name,
        "buyer_email": user.email,
        "paid_at": str(order.updated_at),
        "issued_at": str(order.created_at),
        "company_name": "주식회사 노드엑스",
        "company_registration": "851-81-04102",
    }
