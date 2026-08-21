"""Transfer (ticket ownership) endpoints."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status as http_status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.database import get_db
from app.core.redis import get_redis
from app.middleware.auth import get_current_user
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.user import User
from app.core.errors import ErrorCode, api_error
from app.middleware.rate_limit import rate_limit_auth, rate_limit_sms
from app.services.sms_service import SMSService
from app.services.transfer_service import TransferService

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_VERIFY_ATTEMPTS = 5


class TransferInitiateRequest(BaseModel):
    ticket_id: uuid.UUID
    to_user_id: uuid.UUID
    transfer_type: str = "gift"
    price: float = 0.0


class TransferVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


class TransferResponse(BaseModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    from_user_id: uuid.UUID | None
    to_user_id: uuid.UUID
    status: str
    transfer_type: str
    price: float
    buyer_phone_verified: bool
    initiated_at: str | None = None
    completed_at: str | None = None

    model_config = {"from_attributes": True}


def _to_transfer_response(transfer: OwnershipTransfer) -> TransferResponse:
    return TransferResponse(
        id=transfer.id,
        ticket_id=transfer.ticket_id,
        from_user_id=transfer.from_user_id,
        to_user_id=transfer.to_user_id,
        status=transfer.status,
        transfer_type=transfer.transfer_type.value
        if isinstance(transfer.transfer_type, TransferType)
        else str(transfer.transfer_type),
        price=transfer.price,
        buyer_phone_verified=transfer.buyer_phone_verified,
        initiated_at=transfer.initiated_at.isoformat() if transfer.initiated_at else None,
        completed_at=transfer.completed_at.isoformat() if transfer.completed_at else None,
    )


def _parse_transfer_type(value: str) -> TransferType:
    try:
        return TransferType(value)
    except ValueError as exc:
        valid = ", ".join(t.value for t in TransferType)
        raise ValueError(f"Invalid transfer_type '{value}'. Valid values: {valid}") from exc


@router.post(
    "",
    response_model=TransferResponse,
    summary="티켓 양도 시작",
    description="새로운 티켓 양도를 시작합니다. 양도 유형(gift/sale)과 대상 사용자를 지정합니다. SMS 인증 후 완료됩니다.",
    openapi_extra={"x-agent-hint": "Auth required. POST TransferInitiateRequest with ticket_id, to_user_id, transfer_type (gift/sale), price. Requires SMS verification to complete."},
)
async def initiate_transfer(
    data: TransferInitiateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initiate a new ticket transfer."""
    service = TransferService(db)
    try:
        transfer = await service.initiate_transfer(
            ticket_id=data.ticket_id,
            from_user_id=user.id,
            to_user_id=data.to_user_id,
            transfer_type=_parse_transfer_type(data.transfer_type),
            price=data.price,
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="transfer.initiate",
            resource_type="transfer",
            resource_id=str(transfer.id),
            new_value={
                "ticket_id": str(data.ticket_id),
                "to_user_id": str(data.to_user_id),
                "transfer_type": data.transfer_type,
                "price": data.price,
            },
        )
        await db.commit()
        return _to_transfer_response(transfer)
    except PermissionError as e:
        logger.warning("Transfer permission denied: %s", e)
        raise api_error(ErrorCode.INSUFFICIENT_PERMISSIONS, "Permission denied")
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post(
    "/{transfer_id}/send-code",
    dependencies=[Depends(rate_limit_sms)],
    summary="양도 인증 코드 발송",
    description="양도 거래에 대한 SMS 인증 코드를 발송합니다. 양도 관계자(보내는/받는 사람)만 요청 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required. Sends 6-digit SMS verification code to the user's phone. Only transfer participants can request. Rate-limited: 3 per 10 min."},
)
async def send_transfer_code(
    transfer_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Send SMS verification code for transfer."""
    service = TransferService(db)
    sms = SMSService()
    try:
        transfer = await service._get_transfer_for_update(transfer_id)
        if transfer.to_user_id != user.id and transfer.from_user_id != user.id:
            raise api_error(ErrorCode.TRANSFER_FORBIDDEN, "Not your transfer")
        code = transfer.transfer_code
        if not code:
            code = service._generate_code()
            transfer.transfer_code = code
            await db.flush()
        phone = user.phone if hasattr(user, "phone") and user.phone else None
        if phone:
            await sms.send_transfer_code(to=phone, code=code)
        await db.commit()
        return {"ok": True, "message": "Verification code sent"}
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post(
    "/{transfer_id}/verify",
    response_model=TransferResponse,
    dependencies=[Depends(rate_limit_auth)],
    summary="양도 인증 코드 검증",
    description="SMS로 발송된 6자리 인증 코드를 검증합니다. 10분 내 최대 5회까지 시도 가능합니다.",
    openapi_extra={"x-agent-hint": "Auth required. POST TransferVerifyRequest with 6-digit code. Max 5 attempts per 10 min window. Rate-limited."},
)
async def verify_transfer_code(
    transfer_id: uuid.UUID,
    data: TransferVerifyRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify SMS code for transfer."""
    # Per-transfer attempt limiting
    redis = get_redis()
    attempts_key = f"v2:transfer:verify_attempts:{transfer_id}"
    attempts = await redis.incr(attempts_key)
    if attempts == 1:
        await redis.expire(attempts_key, 600)  # 10 min window
    if attempts > MAX_VERIFY_ATTEMPTS:
        raise HTTPException(
            status_code=http_status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many verification attempts. Please request a new code.",
        )

    service = TransferService(db)
    try:
        transfer = await service._get_transfer_for_update(transfer_id)
        if transfer.to_user_id != user.id and transfer.from_user_id != user.id:
            raise api_error(ErrorCode.TRANSFER_FORBIDDEN, "Not your transfer")
        verified = await service.verify_code(transfer_id=transfer_id, code=data.code)
        await db.commit()
        return _to_transfer_response(verified)
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post(
    "/{transfer_id}/complete",
    response_model=TransferResponse,
    summary="양도 완료",
    description="인증 완료된 양도를 최종 처리합니다. 티켓 소유권이 이전됩니다.",
    openapi_extra={"x-agent-hint": "Auth required. Completes verified transfer. Ticket ownership changes to to_user_id. Only transfer participants can complete."},
)
async def complete_transfer(
    transfer_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Complete transfer after verification."""
    service = TransferService(db)
    try:
        transfer = await service._get_transfer_for_update(transfer_id)
        if transfer.to_user_id != user.id and transfer.from_user_id != user.id:
            raise api_error(ErrorCode.TRANSFER_FORBIDDEN, "Not your transfer")
        completed = await service.complete_transfer(transfer_id=transfer_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="transfer.complete",
            resource_type="transfer",
            resource_id=str(transfer_id),
        )
        await db.commit()
        return _to_transfer_response(completed)
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post(
    "/{transfer_id}/cancel",
    response_model=TransferResponse,
    summary="양도 취소",
    description="진행 중인 양도를 취소합니다. 양도 관계자만 취소할 수 있습니다.",
    openapi_extra={"x-agent-hint": "Auth required. Cancels a pending transfer. Only transfer participants (from/to user) can cancel."},
)
async def cancel_transfer(
    transfer_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a pending transfer."""
    service = TransferService(db)
    try:
        transfer = await service._get_transfer_for_update(transfer_id)
        if transfer.to_user_id != user.id and transfer.from_user_id != user.id:
            raise api_error(ErrorCode.TRANSFER_FORBIDDEN, "Not your transfer")
        cancelled = await service.cancel_transfer(transfer_id=transfer_id)
        await write_audit_log(
            db,
            actor_id=user.id,
            action="transfer.cancel",
            resource_type="transfer",
            resource_id=str(transfer_id),
        )
        await db.commit()
        return _to_transfer_response(cancelled)
    except ValueError as e:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(e))
