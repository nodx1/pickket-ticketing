"""Service for secondary transfer lifecycle (initiate, verify, complete, cancel)."""

from __future__ import annotations

import hmac
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.resale import ResaleListingModel, ResaleListingStatus
from app.models.ticket import Ticket, TicketStatus

logger = logging.getLogger(__name__)

# §26 P0: Transfer code security constants
TRANSFER_CODE_TTL_MINUTES = 30  # Code expires after 30 minutes
TRANSFER_MAX_VERIFY_ATTEMPTS = 5  # Lock after 5 failed attempts


class TransferService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    @staticmethod
    def _generate_code() -> str:
        return f"{secrets.randbelow(1_000_000):06d}"

    @staticmethod
    def _code_expiry() -> datetime:
        """Generate code expiry timestamp (30 minutes from now)."""
        return datetime.now(timezone.utc) + timedelta(minutes=TRANSFER_CODE_TTL_MINUTES)

    async def _get_transfer_for_update(self, transfer_id: uuid.UUID) -> OwnershipTransfer:
        result = await self.session.execute(
            select(OwnershipTransfer).where(OwnershipTransfer.id == transfer_id).with_for_update()
        )
        transfer = result.scalar_one_or_none()
        if not transfer:
            raise ValueError("Transfer not found")
        return transfer

    async def initiate_transfer(
        self,
        *,
        ticket_id: uuid.UUID,
        from_user_id: uuid.UUID,
        to_user_id: uuid.UUID,
        transfer_type: TransferType = TransferType.GIFT,
        price: float = 0.0,
    ) -> OwnershipTransfer:
        # FOR UPDATE: 티켓 행 잠금 — 환불/리세일과의 동시 접근 차단
        result = await self.session.execute(
            select(Ticket).where(Ticket.id == ticket_id).with_for_update()
        )
        ticket = result.scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found")
        if ticket.status != TicketStatus.ACTIVE:
            raise ValueError(f"Ticket is not active (status: {ticket.status})")
        # F1: 최초 입장 후 양도/재판매 차단(입장 후 선물 사기 방지). allpass 는 입장해도
        # status=ACTIVE 이므로 위 status 검사만으로는 못 막는다 → first_checked_in_at 로 가드.
        if getattr(ticket, "first_checked_in_at", None) is not None:
            raise ValueError("이미 입장한 티켓은 양도할 수 없습니다.")
        if ticket.current_owner_id != from_user_id:
            raise PermissionError("Only current owner can initiate transfer")

        # §26 P1: Check if the event allows transfers
        event = await self.session.get(Event, ticket.event_id)
        if not event:
            raise ValueError("Event not found for this ticket")
        if not getattr(event, "is_transferable", True):
            raise ValueError("이 이벤트의 티켓은 양도가 불가능합니다.")

        # Prevent ownership drift while a resale trade is active/in-flight.
        active_listing = await self.session.execute(
            select(ResaleListingModel).where(
                ResaleListingModel.ticket_id == ticket_id,
                ResaleListingModel.status.in_(
                    [ResaleListingStatus.ACTIVE, ResaleListingStatus.MATCHED]
                ),
            )
        )
        if active_listing.scalar_one_or_none():
            raise ValueError("Cannot transfer a ticket with an active resale listing")

        now = self._now()
        transfer = OwnershipTransfer(
            ticket_id=ticket_id,
            from_user_id=from_user_id,
            to_user_id=to_user_id,
            transfer_type=transfer_type,
            price=price,
            seller_amount=0.0,
            platform_fee=0.0,
            artist_royalty=0.0,
            status="initiated",
            initiated_at=now,
            completed_at=None,
            buyer_phone_verified=False,
            transfer_code=self._generate_code(),
            code_expires_at=self._code_expiry(),
            verify_attempts=0,
            transferred_at=now,
        )
        self.session.add(transfer)
        await self.session.flush()
        return transfer

    async def send_code(self, *, transfer_id: uuid.UUID) -> OwnershipTransfer:
        """(Re)issue verification code for an existing transfer."""
        transfer = await self._get_transfer_for_update(transfer_id)

        if transfer.status in {"completed", "cancelled"}:
            raise ValueError(f"Cannot send code for transfer in status '{transfer.status}'")

        transfer.status = "initiated"
        transfer.initiated_at = transfer.initiated_at or self._now()
        transfer.completed_at = None
        transfer.buyer_phone_verified = False
        transfer.transfer_code = self._generate_code()
        transfer.code_expires_at = self._code_expiry()
        transfer.verify_attempts = 0  # Reset attempts on new code
        await self.session.flush()
        return transfer

    async def verify_code(self, *, transfer_id: uuid.UUID, code: str) -> OwnershipTransfer:
        transfer = await self._get_transfer_for_update(transfer_id)

        if transfer.status in {"completed", "cancelled"}:
            raise ValueError(f"Cannot verify code for transfer in status '{transfer.status}'")

        # §26 P0: Check brute-force attempt limit (5 attempts max)
        if transfer.verify_attempts >= TRANSFER_MAX_VERIFY_ATTEMPTS:
            raise ValueError(
                "인증 시도 횟수를 초과했습니다. 새 코드를 요청해주세요."
            )

        # §26 P0: Check code expiry (30 minutes)
        now = self._now()
        if transfer.code_expires_at is not None:
            expires_at = transfer.code_expires_at
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if now > expires_at:
                raise ValueError(
                    "인증 코드가 만료되었습니다. 새 코드를 요청해주세요."
                )

        if not transfer.transfer_code or not hmac.compare_digest(transfer.transfer_code, code):
            # Increment attempt counter on failure
            transfer.verify_attempts = (transfer.verify_attempts or 0) + 1
            await self.session.flush()
            remaining = TRANSFER_MAX_VERIFY_ATTEMPTS - transfer.verify_attempts
            if remaining <= 0:
                raise ValueError(
                    "인증 시도 횟수를 초과했습니다. 새 코드를 요청해주세요."
                )
            raise ValueError(f"잘못된 인증 코드입니다. ({remaining}회 남음)")

        transfer.status = "identity_verified"
        transfer.buyer_phone_verified = True
        transfer.verify_attempts = 0  # Reset on success
        await self.session.flush()
        return transfer

    async def complete_transfer(self, *, transfer_id: uuid.UUID) -> OwnershipTransfer:
        transfer = await self._get_transfer_for_update(transfer_id)

        if transfer.status == "completed":
            return transfer
        if transfer.status != "identity_verified":
            raise ValueError("Transfer must be identity_verified before completion")

        ticket_result = await self.session.execute(
            select(Ticket).where(Ticket.id == transfer.ticket_id).with_for_update()
        )
        ticket = ticket_result.scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found")

        if ticket.current_owner_id != transfer.from_user_id:
            raise ValueError(
                f"Ticket ownership changed since transfer initiation. "
                f"Expected owner {transfer.from_user_id}, actual {ticket.current_owner_id}"
            )

        ticket.current_owner_id = transfer.to_user_id
        ticket.transfer_count += 1
        # 이전 소유자의 디바이스 바인딩 무효화 — 새 소유자가 QR 최초 요청 시 자동 재생성
        ticket.device_hash = None
        ticket.totp_seed = None

        now = self._now()
        transfer.status = "completed"
        transfer.completed_at = now
        transfer.transferred_at = now
        transfer.transfer_code = None

        await self.session.flush()
        return transfer

    async def cancel_transfer(self, *, transfer_id: uuid.UUID) -> OwnershipTransfer:
        transfer = await self._get_transfer_for_update(transfer_id)

        if transfer.status == "completed":
            raise ValueError("Completed transfer cannot be cancelled")
        if transfer.status == "cancelled":
            return transfer

        transfer.status = "cancelled"
        transfer.completed_at = self._now()
        transfer.transfer_code = None
        await self.session.flush()
        return transfer
